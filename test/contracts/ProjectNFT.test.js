const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time, loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');

describe('ProjectNFT (demo drop)', function () {
  const PRICE = ethers.parseEther('0.01');

  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();
    const start = (await time.latest()) + 1000;
    const NFT = await ethers.getContractFactory('ProjectNFT');
    const nft = await NFT.deploy(owner.address, 5, PRICE, 3, start, 'ipfs://cid/');
    await nft.waitForDeployment();
    return { nft, owner, alice, bob, start };
  }
  async function live() { const f = await deploy(); await time.increaseTo(f.start); return f; }
  const mint = (nft, who, qty, value) => nft.connect(who)['mint(uint256)'](qty, { value: value ?? PRICE * BigInt(qty) });

  it('rejects mints before the start time, accepts after', async () => {
    const { nft, alice, start } = await loadFixture(deploy);
    await expect(mint(nft, alice, 1)).to.be.revertedWithCustomError(nft, 'NotStarted');
    await time.increaseTo(start);
    await mint(nft, alice, 1);
    expect(await nft.ownerOf(1)).to.equal(alice.address);
  });

  it('mints quantity, assigns sequential ids and exposes baseURI + id', async () => {
    const { nft, alice } = await live();
    await mint(nft, alice, 3);
    expect(await nft.balanceOf(alice.address)).to.equal(3n);
    expect(await nft.ownerOf(3)).to.equal(alice.address);
    expect(await nft.tokenURI(2)).to.equal('ipfs://cid/2');
    expect(await nft.totalMinted()).to.equal(3n);
  });

  it('requires exact payment and non-zero quantity', async () => {
    const { nft, alice } = await live();
    await expect(mint(nft, alice, 2, PRICE)).to.be.revertedWithCustomError(nft, 'IncorrectPayment');
    await expect(mint(nft, alice, 1, PRICE * 2n)).to.be.revertedWithCustomError(nft, 'IncorrectPayment');
    await expect(mint(nft, alice, 0, 0n)).to.be.revertedWithCustomError(nft, 'ZeroQuantity');
  });

  it('enforces per-wallet cap and total supply', async () => {
    const { nft, alice, bob } = await live();
    await mint(nft, alice, 3);
    await expect(mint(nft, alice, 1)).to.be.revertedWithCustomError(nft, 'WalletLimit');
    await mint(nft, bob, 2);
    const [, , , carol] = await ethers.getSigners();
    await expect(mint(nft, carol, 1)).to.be.revertedWithCustomError(nft, 'SoldOut');
  });

  it('mint(to, quantity) sends tokens to `to` but counts against the caller cap', async () => {
    const { nft, alice, bob } = await live();
    await nft.connect(alice)['mint(address,uint256)'](bob.address, 3, { value: PRICE * 3n });
    expect(await nft.balanceOf(bob.address)).to.equal(3n);
    expect(await nft.mintedBy(alice.address)).to.equal(3n);
    await expect(nft.connect(alice)['mint(address,uint256)'](ethers.ZeroAddress, 1, { value: PRICE }))
      .to.be.revertedWithCustomError(nft, 'ZeroAddress');
  });

  it('only the owner can change settings or withdraw; withdraw moves the balance', async () => {
    const { nft, owner, alice } = await live();
    await mint(nft, alice, 2);
    await expect(nft.connect(alice).setStartTime(1)).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
    await expect(nft.connect(alice).setBaseURI('x')).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
    await expect(nft.connect(alice).withdraw(alice.address)).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
    await expect(nft.connect(owner).withdraw(owner.address)).to.changeEtherBalance(owner, PRICE * 2n);
  });

  it('ownership transfer is two-step', async () => {
    const { nft, owner, alice } = await live();
    await nft.connect(owner).transferOwnership(alice.address);
    expect(await nft.owner()).to.equal(owner.address);
    await nft.connect(alice).acceptOwnership();
    expect(await nft.owner()).to.equal(alice.address);
  });
});
