'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface } = require('ethers');
const { buildMintTx } = require('../../src/core/mintTx');
const { buildFromSpec } = require('../../src/core/mintAdapters');
const feeRecipient = '0x0000a26b00c1F0DF003000390027140000fAa719';

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const nft = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const router = '0xcccccccccccccccccccccccccccccccccccccccc';
const zero = '0x0000000000000000000000000000000000000000';
const seaDrop = new Interface([
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
  'function mintAllowList(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,bytes32[] proof) payable',
  'function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,uint256 salt,bytes signature) payable',
  'function mintAllowedTokenHolder(address nftContract,address feeRecipient,address minterIfNotPayer,(address allowedNftToken,uint256[] allowedNftTokenIds) mintParams) payable'
]);
function schedule({ data, value = '90', chain = 'base', transactionChain = chain, nftContract = nft, to = router, fee = feeRecipient, minter = zero, quantity = 2, ceiling = '100', priceWei = '50', feeBps = 1000 } = {}) {
  return {
    wallet_address: wallet, contract: nft, chain, quantity, price_wei: priceWei, total_wei: ceiling,
    mintSpec: { adapter: 'opensea-drop', slug: 'example-drop', quantity, priceWei, feeBps,
      transaction: { chain: transactionChain, to, data: data || seaDrop.encodeFunctionData('mintPublic', [nftContract, fee, minter, quantity]), value } }
  };
}

test('OpenSea SeaDrop transaction is bound to scheduled collection, wallet, quantity, chain and ceiling', () => {
  const tx = buildMintTx(schedule());
  assert.equal(tx.from, wallet);
  assert.equal(tx.to.toLowerCase(), router.toLowerCase());
  assert.equal(tx.valueWei, '90');
  assert.equal(tx.adapter, 'opensea-drop');
  assert.equal(tx.gasLimit, undefined, 'gas limit is set by the executor gas policy');
});

test('OpenSea adapter accepts known public, allowlist, signed and token-gated SeaDrop V1 selectors', () => {
  const mintParams = [1n, 2n, 1n, 100n, 1n, 20n, 100n, false];
  const variants = [
    seaDrop.encodeFunctionData('mintPublic', [nft, feeRecipient, zero, 2]),
    seaDrop.encodeFunctionData('mintAllowList', [nft, feeRecipient, zero, 2, mintParams, []]),
    seaDrop.encodeFunctionData('mintSigned', [nft, feeRecipient, zero, 2, mintParams, 7, '0x1234']),
    seaDrop.encodeFunctionData('mintAllowedTokenHolder', [nft, feeRecipient, zero, [nft, [10, 11]]])
  ];
  for (const data of variants) assert.equal(buildMintTx(schedule({ data })).adapter, 'opensea-drop');
});

test('OpenSea adapter rejects wrong collection, recipient, quantity, chain, target, selector, and value ceiling', () => {
  assert.throws(() => buildMintTx(schedule({ nftContract: '0xdddddddddddddddddddddddddddddddddddddddd' })), /different NFT contract/);
  assert.throws(() => buildMintTx(schedule({ minter: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' })), /recipient/);
  const wrongQuantityData = seaDrop.encodeFunctionData('mintPublic', [nft, feeRecipient, zero, 2]);
  assert.throws(() => buildMintTx(schedule({ quantity: 3, ceiling: '150', data: wrongQuantityData })), /quantity/);
  assert.throws(() => buildMintTx(schedule({ chain: 'ethereum', transactionChain: 'base' })), /different chain/);
  assert.throws(() => buildMintTx(schedule({ to: 'not-an-address' })), /valid EVM address/);
  const arbitrary = new Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [wallet, 1]);
  assert.throws(() => buildMintTx(schedule({ data: arbitrary })), /unsupported SeaDrop mint function/);
  assert.throws(() => buildMintTx(schedule({ value: '101' })), /spend ceiling/);
  assert.throws(() => buildMintTx(schedule({ fee: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' })), /unexpected primary-sale fee recipient/);
});

test('OpenSea schedule configuration validates and persists its ceiling without storing an API-built transaction', () => {
  const input = {
    wallet_address: wallet, contract: nft, chain: 'base', quantity: 2, price_wei: '50', total_wei: '100',
    mintSpec: { adapter: 'opensea-drop', slug: 'example-drop', quantity: 2, priceWei: '50', feeBps: 1000 }
  };
  const pending = buildFromSpec(input.mintSpec, input);
  assert.equal(pending.pending, true);
  assert.equal(pending.valueWei, 100n);
  assert.throws(() => buildMintTx(input), /must be fetched from its provider/);
  assert.throws(() => buildFromSpec({ ...input.mintSpec, quantity: 101 }, { ...input, quantity: 101 }), /between 1 and 100/);
});

test('OpenSea drop metadata is matched through the chain registry identifier, and unmapped chains fail closed (review #13)', () => {
  const { assertDropMatchesSchedule } = require('../../src/core/openSeaDrops');
  const drop = { drop_type: 'seadrop_v1_erc721', collection_slug: 'x', chain: 'base', contract_address: nft };
  assert.doesNotThrow(() => assertDropMatchesSchedule(drop, { chain: 'base', contract: nft }, 'x'));
  assert.throws(() => assertDropMatchesSchedule({ ...drop, chain: 'ethereum' }, { chain: 'base', contract: nft }, 'x'), /not the selected base network/);
  assert.throws(() => assertDropMatchesSchedule({ ...drop, chain: 'base_sepolia' }, { chain: 'base-sepolia', contract: nft }, 'x'), /not supported on base-sepolia/);
  // Robinhood Chain is mapped since OpenSea added it ("robinhood" in the opensea-js Chain enum).
  assert.doesNotThrow(() => assertDropMatchesSchedule({ ...drop, chain: 'robinhood' }, { chain: 'robinhood', contract: nft }, 'x'));
  assert.throws(() => assertDropMatchesSchedule({ ...drop, chain: 'robinhood' }, { chain: 'local-dev', contract: nft }, 'x'), /not supported on local-dev/);
});
