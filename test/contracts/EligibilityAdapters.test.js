const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { buildMintTx } = require('../../src/core/mintTx');

function schedule(contract, wallet, mintSpec, quantity, price) {
  return { contract, wallet_address: wallet, quantity, price_wei: price.toString(), mintSpec };
}

describe('eligibility adapters ↔ local EVM', function () {
  it('executes a Merkle proof mint and rejects a proof for another wallet', async function () {
    const [alice, bob] = await ethers.getSigners();
    const price = ethers.parseEther('0.01');
    const root = ethers.keccak256(ethers.solidityPacked(['address'], [alice.address]));
    const drop = await (await ethers.getContractFactory('MerkleDrop')).deploy(root, price);
    await drop.waitForDeployment();
    const address = await drop.getAddress();
    const spec = { adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 2, proof: [], priceWei: price.toString() };
    const tx = buildMintTx(schedule(address, alice.address.toLowerCase(), spec, 2, price));
    await alice.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
    expect(await drop.minted(alice.address)).to.equal(2n);
    const bad = buildMintTx(schedule(address, bob.address.toLowerCase(), { ...spec }, 1, price));
    await expect(bob.sendTransaction({ to: bad.to, data: bad.data, value: bad.value })).to.be.revertedWith('proof');
  });

  it('executes an EIP-712 signature mint once and rejects replay/expiry', async function () {
    const [issuer, alice] = await ethers.getSigners();
    const price = ethers.parseEther('0.02');
    const drop = await (await ethers.getContractFactory('SignatureDrop')).deploy(issuer.address, price);
    await drop.waitForDeployment();
    const address = await drop.getAddress();
    const network = await ethers.provider.getNetwork();
    const domain = { name: 'MintPilot Test Drop', version: '1', chainId: network.chainId, verifyingContract: address };
    const types = { Mint: [
      { name: 'to', type: 'address' }, { name: 'quantity', type: 'uint256' },
      { name: 'maxQuantity', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
    ] };
    const deadline = (await time.latest()) + 3600;
    const value = { to: alice.address, quantity: 2, maxQuantity: 3, nonce: 9, deadline };
    const signature = await issuer.signTypedData(domain, types, value);
    const spec = { adapter: 'signature', mintFunction: 'mint(address,uint256,uint256,uint256,uint256,bytes)', ...value, signature, priceWei: price.toString() };
    const tx = buildMintTx(schedule(address, alice.address.toLowerCase(), spec, 2, price));
    await alice.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
    expect(await drop.minted(alice.address)).to.equal(2n);
    await expect(alice.sendTransaction({ to: tx.to, data: tx.data, value: tx.value })).to.be.revertedWith('expired-or-used');
    const expired = { ...value, nonce: 10, deadline: (await time.latest()) - 1 };
    const expiredSig = await issuer.signTypedData(domain, types, expired);
    const expiredSpec = { ...spec, ...expired, signature: expiredSig };
    const expiredTx = buildMintTx(schedule(address, alice.address.toLowerCase(), expiredSpec, 2, price));
    await expect(alice.sendTransaction({ to: expiredTx.to, data: expiredTx.data, value: expiredTx.value })).to.be.revertedWith('expired-or-used');
  });
});
