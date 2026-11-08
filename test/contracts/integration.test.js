// Exercises the bot's ethers-dependent code against a real (local Hardhat) EVM:
// calldata encoding, signature verification (EOA + ERC-1271), receipt parsing and RPC preflight.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { buildMintTx } = require('../../src/core/mintTx');
const { verifyWalletSignature } = require('../../src/core/verifySignature');
const { createRpc, parseReceivedTokenIds } = require('../../src/core/rpc');
const { buildLinkChallenge } = require('../../src/core/sessions');

describe('bot ↔ chain integration', function () {
  const PRICE = ethers.parseEther('0.01');
  let nft, owner, alice, bob, start, addr;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    start = (await time.latest()) + 1000;
    nft = await (await ethers.getContractFactory('ProjectNFT')).deploy(owner.address, 100, PRICE, 10, start, 'ipfs://cid/');
    await nft.waitForDeployment();
    addr = (await nft.getAddress()).toLowerCase();
  });

  const sched = (over) => ({ contract: addr, wallet_address: alice.address.toLowerCase(), quantity: 2, price_wei: PRICE.toString(), preset: 'mint(uint256)', ...over });

  describe('buildMintTx', function () {
    it('mint(uint256): calldata executes on-chain and mints to the wallet', async function () {
      await time.increaseTo(start);
      const tx = buildMintTx(sched());
      expect(BigInt(tx.value)).to.equal(PRICE * 2n);
      expect(tx.valueWei).to.equal((PRICE * 2n).toString());
      await alice.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
      expect(await nft.balanceOf(alice.address)).to.equal(2n);
    });

    it('mint(address,uint256): encodes the linked wallet as recipient', async function () {
      await time.increaseTo(start);
      const tx = buildMintTx(sched({ preset: 'mint(address,uint256)', quantity: 3 }));
      await bob.sendTransaction({ to: tx.to, data: tx.data, value: tx.value }); // bob sends, tokens go to alice
      expect(await nft.balanceOf(alice.address)).to.equal(3n);
    });

    it('encodes the expected selectors and treats price as the total for mint()', function () {
      const iface = new ethers.Interface(['function mint()', 'function mint(uint256)', 'function publicMint(uint256)']);
      expect(buildMintTx(sched({ preset: 'mint()' })).data).to.equal(iface.getFunction('mint()').selector);
      expect(buildMintTx(sched({ preset: 'mint()' })).valueWei).to.equal(PRICE.toString());
      expect(buildMintTx(sched({ preset: 'publicMint(uint256)', quantity: 4 })).data.slice(0, 10)).to.equal(iface.getFunction('publicMint').selector);
      expect(buildMintTx(sched({ quantity: 4 })).valueWei).to.equal((PRICE * 4n).toString());
    });

    it('rejects unknown presets (no arbitrary calldata)', function () {
      expect(() => buildMintTx(sched({ preset: 'transfer(address,uint256)' }))).to.throw(/Unknown mint method/);
    });
  });

  describe('verifyWalletSignature', function () {
    const message = buildLinkChallenge({ domain: 'bot.example', telegramId: 1, nonce: 'abc', issuedAt: 1800000000, expiresAt: 1800000600 });

    it('accepts a genuine EOA signature (case-insensitive address)', async function () {
      const signature = await alice.signMessage(message);
      expect((await verifyWalletSignature({ message, signature, address: alice.address.toLowerCase() }))).to.deep.equal({ ok: true, type: 'eoa' });
    });

    it('rejects a signature from a different key, a tampered message, and garbage', async function () {
      const signature = await bob.signMessage(message);
      expect((await verifyWalletSignature({ message, signature, address: alice.address })).ok).to.equal(false);
      const good = await alice.signMessage(message);
      expect((await verifyWalletSignature({ message: message + ' ', signature: good, address: alice.address })).ok).to.equal(false);
      expect((await verifyWalletSignature({ message, signature: '0x1234', address: alice.address })).ok).to.equal(false);
    });

    it('accepts ERC-1271 smart-contract wallets whose signer signed, and rejects others', async function () {
      const wallet = await (await ethers.getContractFactory('Mock1271Wallet')).deploy(alice.address);
      await wallet.waitForDeployment();
      const walletAddr = await wallet.getAddress();
      const good = await alice.signMessage(message);
      const bad = await bob.signMessage(message);
      expect(await verifyWalletSignature({ message, signature: good, address: walletAddr, provider: ethers.provider })).to.deep.equal({ ok: true, type: 'erc1271' });
      expect((await verifyWalletSignature({ message, signature: bad, address: walletAddr, provider: ethers.provider })).ok).to.equal(false);
      expect((await verifyWalletSignature({ message, signature: good, address: walletAddr })).ok).to.equal(false); // no provider → can't check 1271
    });
  });

  describe('rpc layer', function () {
    const chains = { local: { key: 'local', name: 'Local', chainId: 31337, confirmations: 1, rpcUrl: 'n/a' } };

    it('verifies chain id, simulates reverts, reads receipts and parses received ERC-721 ids', async function () {
      const rpc = createRpc(chains, { providerFactory: () => ethers.provider });
      expect(await rpc.hasCode('local', addr)).to.equal(true);
      expect(await rpc.hasCode('local', bob.address)).to.equal(false);

      const tx = buildMintTx(sched({ preset: 'mint(address,uint256)', quantity: 3 }));
      const pre = await rpc.simulate('local', { from: bob.address, to: tx.to, data: tx.data, value: tx.value });
      expect(pre.ok).to.equal(false);                                    // not started yet → NotStarted

      await time.increaseTo(start);
      expect((await rpc.simulate('local', { from: bob.address, to: tx.to, data: tx.data, value: tx.value })).ok).to.equal(true);

      const sent = await bob.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
      const r = await rpc.getReceipt('local', sent.hash);
      expect(r.status).to.equal('confirmed');
      expect(r.confirmations).to.be.gte(1);
      expect(rpc.parseReceivedTokenIds(r.logs, [alice.address])).to.deep.equal(['1', '2', '3']);
      expect(parseReceivedTokenIds(r.logs, [bob.address])).to.deep.equal([]);   // sender received nothing
      expect(await rpc.getReceipt('local', '0x' + '11'.repeat(32))).to.equal(null);
    });

    it('refuses an RPC that serves the wrong chain id', async function () {
      const wrong = { local: { ...chains.local, chainId: 1 } };
      const rpc = createRpc(wrong, { providerFactory: () => ethers.provider });
      let err; try { await rpc.provider('local'); } catch (e) { err = e; }
      expect(err.message).to.match(/expected 1/);
    });
  });
});
