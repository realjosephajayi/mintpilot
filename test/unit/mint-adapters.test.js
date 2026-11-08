'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface } = require('ethers');
const { buildMintTx } = require('../../src/core/mintTx');

const contract = '0x1111111111111111111111111111111111111111';
const wallet = '0x2222222222222222222222222222222222222222';

test('adapter layer supports safeMint(address,uint256) with quantity pricing', () => {
  const tx = buildMintTx({ wallet_address: wallet, contract, mintSpec: { adapter: 'direct', signature: 'safeMint(address,uint256)', quantity: 2, priceWei: '7' } });
  const iface = new Interface(['function safeMint(address,uint256)']);
  assert.equal(tx.to, contract);
  assert.equal(tx.data.slice(0, 10), iface.getFunction('safeMint').selector);
  assert.equal(tx.valueWei, '14');
  assert.equal(tx.adapter, 'direct');
  assert.equal(tx.gasLimit, undefined);
});

test('adapter layer encodes the official SeaDrop public mint call', () => {
  const tx = buildMintTx({ wallet_address: wallet, contract, mintSpec: {
    adapter: 'seadrop',
    seaDropContract: '0x3333333333333333333333333333333333333333',
    feeRecipient: '0x4444444444444444444444444444444444444444',
    mintPrice: '10',
    quantity: 3,
  } });
  const iface = new Interface(['function mintPublic(address,address,address,uint256)']);
  assert.equal(tx.to, '0x3333333333333333333333333333333333333333');
  assert.equal(tx.data.slice(0, 10), iface.getFunction('mintPublic').selector);
  assert.equal(tx.valueWei, '30');
  assert.equal(tx.adapter, 'seadrop');
  assert.equal(tx.gasLimit, undefined, 'gas limit comes from the gas policy at execution, not a fixed constant');
});

test('SeaDrop signed adapter encodes the verified MintParams tuple and signature', () => {
  const tx = buildMintTx({ wallet_address: wallet, contract: '0xBeC2a7ce41b7BF0fBD2636f16472D8798eE8C0c9', total_wei: '890000000000000', mintSpec: {
    adapter: 'seadrop-signed',
    seaDropContract: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
    nftContract: '0xBeC2a7ce41b7BF0fBD2636f16472D8798eE8C0c9',
    feeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
    quantity: 2,
    mintParams: {
      mintPrice: '445000000000000', maxTotalMintableByWallet: '2', startTime: '1793379600', endTime: '1793383200',
      dropStageIndex: '3', maxTokenSupplyForStage: '3333', feeBps: '1000', restrictFeeRecipients: true
    },
    salt: '112642294141299623656290184500463790789664936575825627057674407284363978210024',
    signature: '0xb9acf90579d256cfb416ea44f7c9ce3952bad159df84e9324d47e424af2eb72a2ad4cbb63521b3b3d06a6101e4e616fd7e55cd65f60cc51178e8e296416654cc1c'
  } });
  const iface = new Interface(['function mintSigned(address,address,address,uint256,(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool),uint256,bytes)']);
  const decoded = iface.decodeFunctionData('mintSigned', tx.data);
  assert.equal(tx.adapter, 'seadrop-signed');
  assert.equal(tx.gasLimit, undefined);
  assert.equal(tx.to, '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5');
  assert.equal(tx.valueWei, '890000000000000');
  assert.equal(decoded[0], '0xBeC2a7ce41b7BF0fBD2636f16472D8798eE8C0c9');
  assert.equal(decoded[3], 2n);
  assert.equal(decoded[4][0], 445000000000000n);
  assert.equal(decoded[4][4], 3n);
  assert.equal(decoded[4][5], 3333n);
  assert.equal(decoded[4][7], true);
  assert.equal(decoded[6].toLowerCase(), '0xb9acf90579d256cfb416ea44f7c9ce3952bad159df84e9324d47e424af2eb72a2ad4cbb63521b3b3d06a6101e4e616fd7e55cd65f60cc51178e8e296416654cc1c');
});

test('adapter layer rejects unallowlisted arbitrary signatures', () => {
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: { adapter: 'direct', signature: 'transfer(address,uint256)', quantity: 1, priceWei: '0' } }), /Unsupported direct mint signature/);
});

test('adapter layer refuses a different direct recipient or target', () => {
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: { adapter: 'direct', signature: 'safeMint(address,uint256)', wallet: '0x4444444444444444444444444444444444444444', quantity: 1, priceWei: '0' } }), /recipient must match/);
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: { adapter: 'direct', signature: 'mint(uint256)', target: '0x5555555555555555555555555555555555555555', quantity: 1, priceWei: '0' } }), /target must match/);
});

test('adapter layer refuses a persisted value mismatch', () => {
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, total_wei: '8', mintSpec: { adapter: 'direct', signature: 'mint(uint256)', quantity: 2, priceWei: '7' } }), /Stored mint value/);
});

test('Merkle adapter encodes a proof and prices per quantity', () => {
  const proof = ['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32)];
  const tx = buildMintTx({ wallet_address: wallet, contract, mintSpec: {
    adapter: 'merkle',
    signatureFunction: 'mint(uint256,bytes32[])',
    quantity: 2,
    proof,
    priceWei: '9'
  } });
  const iface = new Interface(['function mint(uint256,bytes32[])']);
  const decoded = iface.decodeFunctionData('mint', tx.data);
  assert.equal(tx.adapter, 'merkle');
  assert.equal(tx.valueWei, '18');
  assert.equal(decoded[0], 2n);
  assert.deepEqual([...decoded[1]], proof);
});

test('Merkle adapter binds address-bearing calls to the scheduled wallet', () => {
  const proof = ['0x' + 'cc'.repeat(32)];
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: {
    adapter: 'merkle', signatureFunction: 'mint(address,uint256,bytes32[])', wallet: '0x4444444444444444444444444444444444444444', quantity: 1, proof
  } }), /recipient must match/);
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: {
    adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, proof: ['0x1234']
  } }), /bytes32 hash/);
});

test('signature adapter encodes nonce, deadline, and signature bytes', () => {
  const signature = '0x' + '12'.repeat(65);
  const tx = buildMintTx({ wallet_address: wallet, contract, mintSpec: {
    adapter: 'signature',
    mintFunction: 'mint(address,uint256,uint256,uint256,uint256,bytes)',
    quantity: 1,
    maxQuantity: 2,
    nonce: 7,
    deadline: 999999,
    signature,
    priceWei: '11'
  } });
  const iface = new Interface(['function mint(address,uint256,uint256,uint256,uint256,bytes)']);
  const decoded = iface.decodeFunctionData('mint', tx.data);
  assert.equal(tx.adapter, 'signature');
  assert.equal(tx.valueWei, '11');
  assert.equal(decoded[0], wallet);
  assert.equal(decoded[2], 2n);
  assert.equal(decoded[3], 7n);
  assert.equal(decoded[4], 999999n);
  assert.equal(decoded[5], signature);
});

test('signature adapter rejects missing fields and unsupported function shapes', () => {
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: {
    adapter: 'signature', signatureFunction: 'transfer(address,uint256)', quantity: 1, maxQuantity: 1, deadline: 10, signature: '0x'
  } }), /Unsupported signature mint signature/);
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: {
    adapter: 'signature', signatureFunction: 'mint(uint256,uint256,uint256,bytes)', quantity: 1, maxQuantity: 1, deadline: 10
  } }), /Mint signature must be a non-empty hex byte string/);
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: {
    adapter: 'signature', signatureFunction: 'mint(uint256,uint256,uint256,bytes)', quantity: 2, maxQuantity: 1, deadline: 10, signature: '0x12'
  } }), /Max quantity must be at least/);
});

test('token adapter keeps mint calldata allowlisted and carries gate metadata', () => {
  const tx = buildMintTx({ wallet_address: wallet, contract, mintSpec: {
    adapter: 'token', mintFunction: 'mint(uint256)', quantity: 2, priceWei: '4',
    gateContract: '0x5555555555555555555555555555555555555555', standard: 'erc20', minBalance: 3
  } });
  const iface = new Interface(['function mint(uint256)']);
  assert.equal(tx.adapter, 'token');
  assert.equal(tx.eligibility, 'token');
  assert.equal(tx.valueWei, '8');
  assert.equal(iface.decodeFunctionData('mint', tx.data)[0], 2n);
});

test('token adapter rejects unsupported gate standards and arbitrary mint calls', () => {
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: {
    adapter: 'token', mintFunction: 'transfer(address,uint256)', gateContract: wallet, standard: 'erc20'
  } }), /Unsupported direct mint signature/);
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: {
    adapter: 'token', mintFunction: 'mint(uint256)', gateContract: wallet, standard: 'erc999'
  } }), /standard must be/);
});

const SIGNED_SPEC = (mintPrice) => ({
  adapter: 'seadrop-signed',
  seaDropContract: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  nftContract: contract,
  feeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
  quantity: 1,
  mintParams: { mintPrice, maxTotalMintableByWallet: '2', startTime: '1', endTime: '9999999999', dropStageIndex: '1', maxTokenSupplyForStage: '100', feeBps: '1000', restrictFeeRecipients: true },
  salt: '1',
  signature: '0x' + 'ab'.repeat(65)
});

test('SeaDrop signed: the stored total is a ceiling — a lower live price is accepted, a higher one refused (review #7)', () => {
  const base = { wallet_address: wallet, contract, quantity: 1, price_wei: '1000', total_wei: '1000' };
  assert.equal(buildMintTx({ ...base, mintSpec: SIGNED_SPEC('900') }).valueWei, '900');
  assert.equal(buildMintTx({ ...base, mintSpec: SIGNED_SPEC('1000') }).valueWei, '1000');
  assert.throws(() => buildMintTx({ ...base, mintSpec: SIGNED_SPEC('1001') }), /exceeds the scheduled spend ceiling/);
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, quantity: 1, mintSpec: SIGNED_SPEC('1') }), /missing its spend ceiling/);
});

test('SeaDrop public and signed adapters refuse an nftContract other than the scheduled contract (review #8)', () => {
  const other = '0x7777777777777777777777777777777777777777';
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: { adapter: 'seadrop', seaDropContract: '0x3333333333333333333333333333333333333333', nftContract: other, feeRecipient: '0x4444444444444444444444444444444444444444', mintPrice: '0', quantity: 1 } }), /nftContract must match/);
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, total_wei: '1', mintSpec: { ...SIGNED_SPEC('1'), nftContract: other } }), /nftContract must match/);
});

test('provider-backed specs are never turned into calldata before their data is fetched', () => {
  const { buildFromSpec } = require('../../src/core/mintAdapters');
  const spec = { adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 2, priceWei: '5', providerId: 'proofs' };
  const deferred = buildFromSpec(spec, { contract, wallet_address: wallet });
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.valueWei, 10n);
  assert.throws(() => buildMintTx({ wallet_address: wallet, contract, mintSpec: spec }), /must be fetched from its provider/);
});

test('adapter key allowlist rejects unknown fields and file/URL sources in user input (review #1)', () => {
  const { assertSpecKeys } = require('../../src/core/mintAdapters');
  assert.doesNotThrow(() => assertSpecKeys({ adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, priceWei: '0', proof: [] }, 'user'));
  for (const key of ['proofFile', 'proofUrl', 'signatureFile', 'signatureUrl', 'target', 'anything']) {
    assert.throws(() => assertSpecKeys({ adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, [key]: 'x' }, 'user'), new RegExp(`Unsupported field.*${key}`));
  }
  assert.throws(() => assertSpecKeys({ adapter: 'opensea-drop', slug: 'x', quantity: 1, priceWei: '1', feeBps: 0 }, 'user'), /feeBps/);
  assert.doesNotThrow(() => assertSpecKeys({ adapter: 'opensea-drop', slug: 'x', quantity: 1, priceWei: '1', feeBps: 0 }, 'stored'));
  assert.throws(() => assertSpecKeys({ adapter: 'not-real' }, 'user'), /Unsupported mint adapter/);
});
