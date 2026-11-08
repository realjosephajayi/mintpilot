'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AbiCoder, MaxUint256, ZeroAddress, ZeroHash } = require('ethers');
const tw = require('../../src/core/adapters/thirdweb');
const { buildFromSpec, assertSpecKeys } = require('../../src/core/mintAdapters');
const { buildMintTx } = require('../../src/core/mintTx');
const { classifyRevert, notActiveStart, revertLabel, OUTCOME } = require('../../src/core/outcomes');
const { discoverContract } = require('../../src/core/contractDiscovery');
const { createSchedule } = require('../../src/core/schedules');
const { T0, A, makeCfg, makeDb, addUser, addWallet, getChains } = require('./helpers');

const NFT = '0x' + '11'.repeat(20);
const WALLET = '0x' + '22'.repeat(20);
const schedule = (over = {}) => ({ contract: NFT, wallet_address: WALLET, quantity: 2, ...over });
const condition = (over = {}) => ({ startTimestamp: T0 + 100, maxClaimableSupply: 1000n, supplyClaimed: 10n, quantityLimitPerWallet: 5n, merkleRoot: ZeroHash, pricePerToken: 1000n, currency: tw.NATIVE, metadata: '', ...over });
const tuple = (c) => [c.startTimestamp, c.maxClaimableSupply, c.supplyClaimed, c.quantityLimitPerWallet, c.merkleRoot, c.pricePerToken, c.currency, c.metadata];

/** eth_call fake for a multi-phase DropERC721 (or DropERC1155 when tokenId is given). */
function fakeDrop({ conditions, start = 0n, standard = 'erc721', singlePhase = false }) {
  const read = standard === 'erc1155' ? tw.READ_1155 : tw.READ_721;
  return async (to, data) => {
    const parsed = read.parseTransaction({ data });
    if (parsed.name === 'claimCondition') {
      if (singlePhase) return AbiCoder.defaultAbiCoder().encode(['(uint256,uint256,uint256,uint256,bytes32,uint256,address,string)'], [tuple(conditions[0])]);
      return AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [start, BigInt(conditions.length)]);
    }
    const id = Number(parsed.args.at(-1) - start);
    return read.encodeFunctionResult('getClaimConditionById', [tuple(conditions[id])]);
  };
}

test('thirdweb claim calldata matches the published selectors and binds receiver, token ID, price and the no-override proof', () => {
  assert.equal(tw.CLAIM_721.getFunction('claim').selector, '0x84bb1e42');
  assert.equal(tw.CLAIM_1155.getFunction('claim').selector, '0x57bc3d78');
  const b721 = tw.normalize({ adapter: 'thirdweb-drop', standard: 'erc721', quantity: 2, pricePerToken: '1000' }, schedule());
  const a721 = tw.CLAIM_721.decodeFunctionData('claim', b721.data);
  assert.equal(a721[0].toLowerCase(), WALLET);
  assert.equal(a721[1], 2n);
  assert.equal(a721[2], tw.NATIVE);
  assert.equal(a721[3], 1000n);
  assert.deepEqual([...a721[4][0]], []);
  assert.equal(a721[4][1], 0n); assert.equal(a721[4][2], MaxUint256); assert.equal(a721[4][3], ZeroAddress);
  assert.equal(b721.valueWei, 2000n); // exact: thirdweb requires msg.value == quantity × price
  assert.equal(b721.target.toLowerCase(), NFT);
  const b1155 = tw.normalize({ adapter: 'thirdweb-drop', standard: 'erc1155', tokenId: '7', quantity: 2, pricePerToken: '5' }, schedule());
  const a1155 = tw.CLAIM_1155.decodeFunctionData('claim', b1155.data);
  assert.equal(a1155[1], 7n); assert.equal(a1155[2], 2n); assert.equal(b1155.tokenId, '7');
});

test('thirdweb binding: ERC-20 currency, missing/foreign token ID, quantity mismatch and unknown keys are refused', () => {
  assert.throws(() => tw.normalize({ standard: 'erc721', quantity: 2, pricePerToken: '1', currency: A(9) }, schedule()), /native-coin/);
  assert.throws(() => tw.normalize({ standard: 'erc1155', quantity: 2, pricePerToken: '1' }, schedule()), /token ID/);
  assert.throws(() => tw.normalize({ standard: 'erc721', tokenId: '1', quantity: 2, pricePerToken: '1' }, schedule()), /ERC-1155 drops only/);
  assert.throws(() => tw.normalize({ standard: 'erc721', quantity: 3, pricePerToken: '1' }, schedule()), /does not match/);
  assert.throws(() => assertSpecKeys({ adapter: 'thirdweb-drop', standard: 'erc721', receiver: A(5) }, 'user'), /receiver/);
  assert.doesNotThrow(() => assertSpecKeys({ adapter: 'thirdweb-drop', standard: 'erc721', quantity: 1, pricePerToken: '1', currency: tw.NATIVE, phaseId: 0 }, 'stored'));
});

test('thirdweb phases: multi-phase and single-phase getters are read; allowlist and ERC-20 phases are refused with reasons', async () => {
  const conditions = [condition(), condition({ startTimestamp: T0 + 500, merkleRoot: '0x' + 'ab'.repeat(32) }), condition({ startTimestamp: T0 + 900, currency: A(9) })];
  const read = await tw.readPhases(fakeDrop({ conditions, start: 3n }), NFT);
  assert.equal(read.variant, 'multi-phase');
  assert.deepEqual(read.phases.map((p) => p.id), [3, 4, 5]);
  assert.equal(tw.phaseBlocker(read.phases[0]), null);
  assert.match(tw.phaseBlocker(read.phases[1]), /allowlist-only/);
  assert.match(tw.phaseBlocker(read.phases[2]), /ERC-20/);
  assert.equal(tw.phaseAt(read.phases, T0).id, 3, 'before any start: the next phase');
  assert.equal(tw.phaseAt(read.phases, T0 + 600).id, 4, 'latest started phase');
  const single = await tw.readPhases(fakeDrop({ conditions: [condition()], singlePhase: true }), NFT);
  assert.equal(single.variant, 'single-phase');
  assert.equal(single.phases[0].pricePerToken, '1000');
  const erc1155 = await tw.readPhases(fakeDrop({ conditions: [condition()], standard: 'erc1155' }), NFT, { standard: 'erc1155', tokenId: 4n });
  assert.equal(erc1155.tokenId, '4');
  assert.equal(await tw.readPhases(async () => { throw new Error('execution reverted'); }, NFT), null, 'not a thirdweb drop');
});

test('thirdweb reverts: not started waits (and names its start); sold out, wallet limit and changed price are terminal', () => {
  const notStarted = tw.ERRORS.encodeErrorResult('DropClaimNotStarted', [BigInt(T0 + 120), BigInt(T0)]);
  assert.equal(classifyRevert(notStarted, { chainTime: T0, launchAt: null, graceSec: 0 }), OUTCOME.WAIT);
  assert.equal(notActiveStart(notStarted, T0), T0 + 120);
  assert.equal(classifyRevert(tw.ERRORS.encodeErrorResult('DropNoActiveCondition', []), { chainTime: T0, launchAt: null, graceSec: 0 }), OUTCOME.WAIT);
  for (const [name, args] of [['DropClaimExceedLimit', [5n, 6n]], ['DropClaimExceedMaxSupply', [10n, 11n]], ['DropClaimInvalidTokenPrice', [tw.NATIVE, 1n, tw.NATIVE, 2n]]]) {
    const data = tw.ERRORS.encodeErrorResult(name, args);
    assert.equal(classifyRevert(data, { chainTime: T0, launchAt: T0, graceSec: 9999 }), OUTCOME.TERMINAL, name);
  }
  assert.match(revertLabel(tw.ERRORS.encodeErrorResult('DropClaimInvalidTokenPrice', [tw.NATIVE, 1n, tw.NATIVE, 2n])), /price or currency changed/);
});

test('thirdweb schedules: stored exactly, pre-signable calldata, and an exact (not ceiling) value check', () => {
  const cfg = makeCfg(); const db = makeDb(); const chains = getChains(cfg);
  addUser(db, 1); addWallet(db, cfg, 1, WALLET);
  const mintSpec = { adapter: 'thirdweb-drop', standard: 'erc721', quantity: 2, pricePerToken: '1000', currency: tw.NATIVE, phaseId: 3 };
  for (const chain of ['ink', 'arbitrum', 'robinhood']) {
    const id = createSchedule(db, cfg, chains, { telegramId: 1, chain, contract: NFT, preset: 'adapter:thirdweb-drop', mintSpec, quantity: 2, priceWei: 1000n, scheduledAt: T0 + 60, wallet: WALLET }, T0);
    const row = db.prepare('SELECT * FROM schedules WHERE id=?').get(id);
    assert.equal(row.total_wei, '2000');
    const tx = buildMintTx(row);
    assert.equal(tx.to.toLowerCase(), NFT);
    assert.equal(tx.valueWei, '2000');
    assert.equal(tx.adapter, 'thirdweb-drop');
  }
  const tampered = { ...db.prepare('SELECT * FROM schedules LIMIT 1').get(), total_wei: '1999' };
  assert.throws(() => buildMintTx(tampered), /does not match/);
  assert.equal(buildFromSpec(mintSpec, schedule()).label, 'thirdweb ERC-721 claim');
});

test('discovery recognises a thirdweb ERC-721 drop and reads its phases in parallel with the other reads', async () => {
  const conditions = [condition()];
  const drop = fakeDrop({ conditions });
  const provider = {
    getCode: async () => '0x6080',
    getStorage: async () => '0x' + '00'.repeat(32),
    call: async ({ to, data }) => {
      if (data.startsWith('0x01ffc9a7')) { // supportsInterface
        const id = '0x' + data.slice(10, 18);
        return AbiCoder.defaultAbiCoder().encode(['bool'], [id === '0x80ac58cd' || id === '0x01ffc9a7']);
      }
      try { return await drop(to, data); } catch { throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }); }
    }
  };
  const d = await discoverContract(provider, NFT, { chain: null, abiSources: null });
  assert.equal(d.protocol, 'thirdweb-drop');
  assert.equal(d.thirdwebDrop.standard, 'erc721');
  assert.equal(d.thirdwebDrop.phases[0].pricePerToken, '1000');
});
