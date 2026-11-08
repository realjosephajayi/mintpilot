const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { buildMintTx } = require('../../src/core/mintTx');
const tw = require('../../src/core/adapters/thirdweb');
const { classifyRevert, OUTCOME } = require('../../src/core/outcomes');
const { parseReceivedTokenIds } = require('../../src/core/rpc');

const call = (to, data) => ethers.provider.call({ to, data });
const schedule = (contract, wallet, mintSpec, quantity, total) => ({ contract: contract.toLowerCase(), wallet_address: wallet.toLowerCase(), quantity, total_wei: total.toString(), mintSpec });

describe('thirdweb drop adapter ↔ local EVM', function () {
  it('ERC-721: phases are read from the contract, the claim reverts DropClaimNotStarted before the start, then mints to the scheduled wallet', async function () {
    const [, alice] = await ethers.getSigners();
    const price = ethers.parseEther('0.001');
    const start = (await time.latest()) + 120;
    const drop = await (await ethers.getContractFactory('ThirdwebDrop721Mock')).deploy(start, price, 2, 100);
    await drop.waitForDeployment();
    const address = await drop.getAddress();

    const read = await tw.readPhases(call, address);
    expect(read.variant).to.equal('multi-phase');
    expect(read.phases[0]).to.include({ startTimestamp: start, pricePerToken: price.toString(), quantityLimitPerWallet: '2', allowlist: false, nativePrice: true });

    const spec = { adapter: 'thirdweb-drop', standard: 'erc721', quantity: 2, pricePerToken: read.phases[0].pricePerToken, currency: tw.NATIVE, phaseId: 0 };
    const tx = buildMintTx(schedule(address, alice.address, spec, 2, price * 2n));
    // Before the start: a decodable "not open yet" revert, classified as WAIT (the launch engine keeps probing).
    let data;
    try { await ethers.provider.call({ from: alice.address, to: tx.to, data: tx.data, value: tx.value }); } catch (e) { data = e.data; }
    expect(classifyRevert(data, { chainTime: start - 1, launchAt: start, graceSec: 0 })).to.equal(OUTCOME.WAIT);

    await time.increaseTo(start);
    const receipt = await (await alice.sendTransaction({ to: tx.to, data: tx.data, value: tx.value })).wait();
    expect(await drop.balanceOf(alice.address)).to.equal(2n);
    expect(parseReceivedTokenIds(receipt.logs, [alice.address])).to.deep.equal(['0', '1']);

    // A third NFT exceeds the per-wallet limit: terminal, never retried.
    const more = buildMintTx(schedule(address, alice.address, { ...spec, quantity: 1 }, 1, price));
    try { await ethers.provider.call({ from: alice.address, to: more.to, data: more.data, value: more.value }); } catch (e) { data = e.data; }
    expect(classifyRevert(data, { chainTime: start + 10, launchAt: start, graceSec: 9999 })).to.equal(OUTCOME.TERMINAL);
  });

  it('ERC-721: a stale price (creator changed the phase) is refused by the contract and classified terminal', async function () {
    const [, alice] = await ethers.getSigners();
    const price = ethers.parseEther('0.002');
    const drop = await (await ethers.getContractFactory('ThirdwebDrop721Mock')).deploy(0, price, 5, 100);
    await drop.waitForDeployment();
    const address = await drop.getAddress();
    const stale = buildMintTx(schedule(address, alice.address, { adapter: 'thirdweb-drop', standard: 'erc721', quantity: 1, pricePerToken: '1000', currency: tw.NATIVE }, 1, 1000n));
    let data;
    try { await ethers.provider.call({ from: alice.address, to: stale.to, data: stale.data, value: stale.value }); } catch (e) { data = e.data; }
    expect(classifyRevert(data, { chainTime: Number(await time.latest()), launchAt: 0, graceSec: 9999 })).to.equal(OUTCOME.TERMINAL);
  });

  it('ERC-1155: the token ID is bound, phases are read per token, and the TransferSingle receipt reports id × quantity', async function () {
    const [, , bob] = await ethers.getSigners();
    const price = ethers.parseEther('0.0005');
    const drop = await (await ethers.getContractFactory('ThirdwebDrop1155Mock')).deploy(7, 0, price, 3, 50);
    await drop.waitForDeployment();
    const address = await drop.getAddress();
    const read = await tw.readPhases(call, address, { standard: 'erc1155', tokenId: 7n });
    expect(read.phases).to.have.length(1);
    expect(await tw.readPhases(call, address, { standard: 'erc1155', tokenId: 8n }).then((r) => r.phases.length)).to.equal(0);
    const tx = buildMintTx(schedule(address, bob.address, { adapter: 'thirdweb-drop', standard: 'erc1155', tokenId: '7', quantity: 3, pricePerToken: price.toString(), currency: tw.NATIVE }, 3, price * 3n));
    const receipt = await (await bob.sendTransaction({ to: tx.to, data: tx.data, value: tx.value })).wait();
    expect(await drop.balanceOf(bob.address, 7)).to.equal(3n);
    expect(parseReceivedTokenIds(receipt.logs, [bob.address])).to.deep.equal(['7 ×3']);
  });
});
