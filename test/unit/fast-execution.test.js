'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface, Network, Transaction, keccak256 } = require('ethers');
const { T0, A, makeCfg, makeDb, addUser, addSignableWallet, getChains, silent } = require('./helpers');
const { createFastExecution } = require('../../src/core/fastExecution');
const { createSchedule, getSchedule } = require('../../src/core/schedules');
const { OUTCOME, SEADROP_ERRORS } = require('../../src/core/outcomes');

const NFT = A(5);
const ROUTER = '0x00005ea00ac477b1030ce78506496e8c2de24bf5';
const NOT_ACTIVE = (end) => SEADROP_ERRORS.encodeErrorResult('NotActive', [T0, T0 + 100, end]);
const SOLD_OUT = SEADROP_ERRORS.encodeErrorResult('MintQuantityExceedsMaxSupply', [10, 5]);

function harness({ cfgOver = {}, automation = {}, chainKey = 'base', rpcOver = {}, providerOver = {}, schedule = {}, now = T0 + 3600 } = {}) {
  const cfg = makeCfg(cfgOver);
  cfg.automation = { ...cfg.automation, ...automation };
  const chains = getChains(cfg);
  const db = makeDb();
  addUser(db, 1);
  const wallet = addSignableWallet(db, cfg, 1);
  let t = now;
  const calls = { broadcast: [], estimate: 0, simulate: [], getTransaction: 0 };
  const chainId = chains[chainKey].chainId;
  const provider = {
    getNetwork: async () => Network.from(chainId),
    getTransactionCount: async () => 7,
    getFeeData: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gasPrice: null }),
    estimateGas: async () => 100000n,
    broadcastTransaction: async (raw) => { calls.broadcast.push(raw); return { hash: Transaction.from(raw).hash }; },
    ...providerOver
  };
  const rpc = {
    provider: async () => provider,
    // Same contract as createRpc().broadcast: resolves on acceptance, rethrows the node's error.
    broadcast: async (key, raw) => { await provider.broadcastTransaction(raw); return { hash: Transaction.from(raw).hash, ackMs: 1, host: 'fake' }; },
    getFeeInputs: async () => ({ baseFeePerGas: 1n, priorityFeePerGas: 0n, gasPrice: null, timestamp: t, number: 1 }),
    getBalance: async () => (10n ** 18n).toString(),
    estimateGas: async () => { calls.estimate += 1; return 100000n; },
    getFeeData: async () => ({ maxFeePerGas: 2n }),
    simulate: async (key, tx) => { calls.simulate.push(tx); return { ok: true }; },
    getAllowedSeaDrop: async () => [ROUTER],
    getTransaction: async () => { calls.getTransaction += 1; return null; },
    getNonce: async () => 7,
    getChainTime: async () => now,
    ...rpcOver
  };
  const fx = createFastExecution({ rpc, db, cfg, chains, log: silent, now: () => t });
  const id = createSchedule(db, cfg, chains, { telegramId: 1, chain: chainKey, contract: NFT, preset: 'mint(uint256)', quantity: 1, priceWei: '0.001', scheduledAt: T0 + 3600, wallet: wallet.address, ...schedule }, T0);
  return { cfg, db, chains, rpc, provider, fx, calls, wallet, schedule: () => getSchedule(db, id), id, setNow: (x) => { t = x; } };
}

const attempts = (db, id) => db.prepare('SELECT * FROM execution_attempts WHERE schedule_id=? ORDER BY id').all(id);

test('a schedule is signed locally, persisted with hash+nonce+raw BEFORE broadcast, then broadcast once', async () => {
  let rowAtBroadcast = null;
  const h = harness({ providerOver: { broadcastTransaction: async (raw) => { rowAtBroadcast = attempts(h.db, h.id)[0]; h.calls.broadcast.push(raw); return {}; } } });
  const r = await h.fx.execute(h.schedule());
  assert.equal(r.outcome, OUTCOME.SUBMITTED);
  assert.equal(h.calls.broadcast.length, 1);
  const raw = h.calls.broadcast[0];
  const parsed = Transaction.from(raw);
  assert.equal(r.txHash, keccak256(raw));
  assert.equal(parsed.from.toLowerCase(), h.wallet.address);
  assert.equal(parsed.to.toLowerCase(), NFT);
  assert.equal(parsed.value, 10n ** 15n);
  assert.equal(parsed.gasLimit, 125000n, 'estimate × 1.25');
  assert.equal(parsed.nonce, 7);
  assert.equal(rowAtBroadcast.status, 'submitting');
  assert.equal(rowAtBroadcast.tx_hash, r.txHash);
  assert.equal(rowAtBroadcast.nonce, 7);
  assert.equal(rowAtBroadcast.raw_tx, raw);
  assert.equal(attempts(h.db, h.id)[0].status, 'submitted');
});

test('deployment gates: automation off, chain not allowlisted, value cap', async () => {
  const off = harness();
  off.cfg.automation.enabled = false;
  assert.match((await off.fx.execute(off.schedule())).userReason, /not configured/);
  const notListed = harness();
  notListed.cfg.automation.allowedChains = ['ethereum'];
  assert.equal((await notListed.fx.execute(notListed.schedule())).outcome, OUTCOME.TERMINAL);
  const capped = harness();
  capped.cfg.automation.maxValueEth = '0.0001';
  assert.match((await capped.fx.execute(capped.schedule())).userReason, /automatic-signing cap/);
  for (const h of [off, notListed, capped]) assert.equal(h.calls.broadcast.length, 0);
});

test('every registry mainnet signs with its own chain id once allowlisted (mainnets only)', async () => {
  for (const [key, id] of [['arbitrum', 42161n], ['zora', 7777777n], ['robinhood', 4663n]]) {
    const h = harness({ automation: { allowedChains: [key] }, chainKey: key });
    const r = await h.fx.execute(h.schedule());
    assert.equal(r.outcome, OUTCOME.SUBMITTED, key);
    assert.equal(Transaction.from(h.calls.broadcast[0]).chainId, id, key);
  }
});

test('a chain added to the registry stays off until AUTOMATION_ALLOWED_CHAINS lists it (review #17)', async () => {
  const h = harness();
  h.chains.newmainnet = { ...h.chains.base, key: 'newmainnet', name: 'New Mainnet' };
  h.cfg.automation.allowedChains = ['base'];
  const r = await h.fx.execute({ ...h.schedule(), chain: 'newmainnet' });
  assert.equal(r.outcome, OUTCOME.TERMINAL);
  assert.match(r.userReason, /not enabled for New Mainnet/);
});

test('reverts are classified: SeaDrop NotActive waits, other SeaDrop errors stop, unknown reverts wait only within the grace window (review #2)', async () => {
  const end = T0 + 99999;
  const notActive = harness({ rpcOver: { simulate: async () => ({ ok: false, reason: 'reverted', data: NOT_ACTIVE(end) }) } });
  assert.equal((await notActive.fx.execute(notActive.schedule(), { chainTime: T0 + 3600 })).outcome, OUTCOME.WAIT);
  const soldOut = harness({ rpcOver: { simulate: async () => ({ ok: false, reason: 'reverted', data: SOLD_OUT }) } });
  const r = await soldOut.fx.execute(soldOut.schedule(), { chainTime: T0 + 3600 });
  assert.equal(r.outcome, OUTCOME.TERMINAL);
  assert.match(r.userReason, /sold out/);
  const unknown = harness({ rpcOver: { simulate: async () => ({ ok: false, reason: 'execution reverted', data: '0x' }) } });
  assert.equal((await unknown.fx.execute(unknown.schedule(), { chainTime: T0 + 3600 + 60 })).outcome, OUTCOME.WAIT, 'inside the 120 s grace window');
  assert.equal((await unknown.fx.execute(unknown.schedule(), { chainTime: T0 + 3600 + 121 })).outcome, OUTCOME.TERMINAL, 'after the grace window');
  const flaky = harness({ rpcOver: { simulate: async () => ({ ok: false, retryable: true, reason: 'RPC unavailable' }) } });
  assert.equal((await flaky.fx.execute(flaky.schedule())).outcome, OUTCOME.RETRY);
  for (const h of [notActive, soldOut, unknown, flaky]) assert.equal(h.calls.broadcast.length, 0);
});

test('insufficient balance waits (with a funds notice) instead of failing; gas over the cap is terminal', async () => {
  const poor = harness({ rpcOver: { getBalance: async () => '1' } });
  const r = await poor.fx.execute(poor.schedule());
  assert.equal(r.outcome, OUTCOME.WAIT);
  assert.equal(r.notify, 'funds');
  const noGas = harness({ rpcOver: { getBalance: async () => (10n ** 15n + 1n).toString() } });
  assert.equal((await noGas.fx.execute(noGas.schedule())).notify, 'funds', 'value is covered but the gas reserve is not');
  const greedy = harness({ rpcOver: { estimateGas: async () => 300001n } });
  const g = await greedy.fx.execute(greedy.schedule());
  assert.equal(g.outcome, OUTCOME.TERMINAL);
  assert.match(g.userReason, /exceeds the cap 300000 for 1 token/);
});

test('dry run runs every check and reports what it would send, without signing (review #5)', async () => {
  const h = harness({ automation: { dryRun: true } });
  const r = await h.fx.execute(h.schedule());
  assert.equal(r.outcome, OUTCOME.DRY_RUN);
  assert.match(r.userReason, /would send 0.001 ETH/);
  assert.equal(h.calls.simulate.length, 1);
  assert.equal(h.calls.estimate, 1);
  assert.equal(h.calls.broadcast.length, 0);
  assert.equal(attempts(h.db, h.id).length, 0);
});

test('a lost wallet lease stops execution before signing or before broadcast', async () => {
  const before = harness();
  assert.equal((await before.fx.execute(before.schedule(), { assertLock: () => false })).outcome, OUTCOME.LEASE_LOST);
  assert.equal(attempts(before.db, before.id).length, 0);
  const late = harness();
  let checks = 0;
  assert.equal((await late.fx.execute(late.schedule(), { assertLock: () => { checks += 1; return checks < 2; } })).outcome, OUTCOME.LEASE_LOST);
  assert.equal(late.calls.broadcast.length, 0);
  assert.equal(attempts(late.db, late.id)[0].status, 'failed');
});

test('node rejections are not "uncertain": insufficient funds waits, nonce too low retries (review #4)', async () => {
  const funds = harness({ providerOver: { broadcastTransaction: async () => { throw Object.assign(new Error('insufficient funds'), { code: 'INSUFFICIENT_FUNDS' }); } } });
  const r = await funds.fx.execute(funds.schedule());
  assert.equal(r.outcome, OUTCOME.WAIT);
  assert.equal(r.notify, 'funds');
  assert.equal(attempts(funds.db, funds.id)[0].status, 'failed');
  const nonce = harness({ providerOver: { broadcastTransaction: async () => { throw Object.assign(new Error('nonce has already been used'), { code: 'NONCE_EXPIRED' }); } } });
  assert.equal((await nonce.fx.execute(nonce.schedule())).outcome, OUTCOME.RETRY);
  // After a definite rejection the schedule can be signed again (the attempt is closed).
  nonce.provider.broadcastTransaction = async (raw) => { nonce.calls.broadcast.push(raw); return {}; };
  assert.equal((await nonce.fx.execute(nonce.schedule())).outcome, OUTCOME.SUBMITTED);
});

test('an ambiguous broadcast is reconciled by hash and never signed twice (review #4)', async () => {
  let signed = 0;
  const h = harness({ providerOver: { broadcastTransaction: async () => { throw Object.assign(new Error('socket hang up'), { code: 'NETWORK_ERROR' }); } } });
  const realExecute = h.fx.execute;
  const first = await realExecute(h.schedule());
  assert.equal(first.outcome, OUTCOME.UNCERTAIN);
  assert.ok(first.txHash);
  const row = attempts(h.db, h.id)[0];
  assert.equal(row.status, 'uncertain');
  assert.equal(row.tx_hash, first.txHash);
  // Not visible yet and nonce still free: the SAME signed bytes are re-sent; the node answers ambiguously again.
  h.provider.broadcastTransaction = async (raw) => { signed += 1; h.calls.broadcast.push(raw); throw Object.assign(new Error('already known'), { code: 'UNKNOWN_ERROR' }); };
  const second = await h.fx.execute(h.schedule());
  assert.equal(second.outcome, OUTCOME.UNCERTAIN);
  assert.equal(h.calls.broadcast.at(-1), row.raw_tx);
  // Visible now: reported as submitted with the original hash.
  h.rpc.getTransaction = async () => ({ hash: first.txHash });
  const third = await h.fx.execute(h.schedule());
  assert.equal(third.outcome, OUTCOME.SUBMITTED);
  assert.equal(third.txHash, first.txHash);
  assert.equal(signed, 1, 'only the identical bytes were re-sent');
  assert.equal(attempts(h.db, h.id).length, 1, 'no second attempt or signature');
});

test('a re-sent identical transaction that the node accepts is recorded as submitted', async () => {
  const h = harness({ providerOver: { broadcastTransaction: async () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } } });
  const first = await h.fx.execute(h.schedule());
  const raw = attempts(h.db, h.id)[0].raw_tx;
  h.provider.broadcastTransaction = async (bytes) => { h.calls.broadcast.push(bytes); return {}; };
  const again = await h.fx.execute(h.schedule());
  assert.equal(again.outcome, OUTCOME.SUBMITTED);
  assert.equal(again.txHash, first.txHash);
  assert.deepEqual(h.calls.broadcast, [raw]);
  assert.equal(attempts(h.db, h.id)[0].status, 'submitted');
});

test('a nonce consumed by another transaction releases the attempt only after a confirmation delay', async () => {
  const h = harness({ providerOver: { broadcastTransaction: async () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } } });
  await h.fx.execute(h.schedule());
  h.rpc.getNonce = async () => 8; // latest nonce moved past ours (7) and our hash is unknown
  assert.equal((await h.fx.execute(h.schedule())).outcome, OUTCOME.UNCERTAIN, 'first observation only marks it');
  assert.equal((await h.fx.execute(h.schedule())).outcome, OUTCOME.UNCERTAIN, 'still inside the confirmation delay');
  h.setNow(T0 + 3600 + 61);
  const r = await h.fx.execute(h.schedule());
  assert.equal(r.outcome, OUTCOME.RETRY);
  assert.equal(attempts(h.db, h.id)[0].status, 'failed');
});

test('legacy uncertain attempts without a hash stop with an explicit message instead of looping', async () => {
  const h = harness();
  h.db.prepare("INSERT INTO execution_attempts (schedule_id, chain, wallet_address, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(h.id, 'base', h.wallet.address, 'uncertain', T0, T0);
  const r = await h.fx.execute(h.schedule());
  assert.equal(r.outcome, OUTCOME.TERMINAL);
  assert.match(r.userReason, /unknown outcome/);
});

test('every SeaDrop route checks the NFT-authorized router before signing (review #8)', async () => {
  const spec = { adapter: 'seadrop', seaDropContract: ROUTER, nftContract: NFT, mintPrice: '1000', feeBps: 0, restrictFeeRecipients: false, feeRecipient: '0x0000000000000000000000000000000000000000' };
  const ok = harness({ schedule: { preset: undefined, mintSpec: spec, priceWei: 1000n } });
  const r = await ok.fx.execute(ok.schedule());
  assert.equal(r.outcome, OUTCOME.SUBMITTED);
  assert.equal(Transaction.from(ok.calls.broadcast[0]).to.toLowerCase(), ROUTER);
  const rogue = harness({ schedule: { preset: undefined, mintSpec: spec, priceWei: 1000n }, rpcOver: { getAllowedSeaDrop: async () => ['0x1111111111111111111111111111111111111111'] } });
  const bad = await rogue.fx.execute(rogue.schedule());
  assert.equal(bad.outcome, OUTCOME.TERMINAL);
  assert.match(bad.userReason, /not authorized/);
  assert.equal(rogue.calls.broadcast.length, 0);
});

test('OpenSea REST execution simulates the fresh API transaction and respects the spend ceiling', async () => {
  const seaDrop = new Interface(['function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable']);
  const realFetch = globalThis.fetch;
  let value = '900';
  globalThis.fetch = async () => new Response(JSON.stringify({ chain: 'base', to: ROUTER, data: seaDrop.encodeFunctionData('mintPublic', [NFT, '0x0000a26b00c1F0DF003000390027140000fAa719', '0x0000000000000000000000000000000000000000', 1]), value }), { status: 200 });
  try {
    const h = harness({ cfgOver: { openSeaApiKey: 'fx-key' }, schedule: { preset: undefined, mintSpec: { adapter: 'opensea-drop', slug: 'drop', quantity: 1, priceWei: '1000', feeBps: 1000 }, priceWei: 1000n } });
    const r = await h.fx.execute(h.schedule());
    assert.equal(r.outcome, OUTCOME.SUBMITTED);
    assert.equal(h.calls.simulate[0].valueWei, '900');
    value = '1001';
    const over = harness({ cfgOver: { openSeaApiKey: 'fx-key-2' }, schedule: { preset: undefined, mintSpec: { adapter: 'opensea-drop', slug: 'drop', quantity: 1, priceWei: '1000', feeBps: 1000 }, priceWei: 1000n } });
    const refused = await over.fx.execute(over.schedule());
    assert.equal(refused.outcome, OUTCOME.TERMINAL);
    assert.match(refused.userReason, /exceeds the scheduled spend ceiling/);
  } finally { globalThis.fetch = realFetch; }
});

test('an undecryptable key is terminal and nothing is broadcast', async () => {
  const h = harness();
  h.cfg.automation.encryptionKey = 'bb'.repeat(32);
  const r = await h.fx.execute(h.schedule());
  assert.equal(r.outcome, OUTCOME.TERMINAL);
  assert.match(r.userReason, /could not be decrypted/);
  assert.equal(h.calls.broadcast.length, 0);
});

// --- Launch engine primitives: arm (pre-sign), fire (broadcast only), probe, parallel reads ---------------
const { ARM } = require('../../src/core/fastExecution');
const { cancelSchedule } = require('../../src/core/schedules');

const LAUNCH = T0 + 3650; // harness "now" is T0 + 3600: inside the 60 s arming window
const closed = (data = '0x') => ({
  simulate: async () => ({ ok: false, reason: 'execution reverted', data }),
  estimateGas: async () => { throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data }); }
});
const launchSchedule = (over = {}) => ({ triggerMode: 'launch', launchAt: LAUNCH, scheduledAt: T0, ...over });

test('arm pre-signs a closed launch mint: gas cap as limit, no tip on Robinhood, fee headroom, nothing sent', async () => {
  const h = harness({ chainKey: 'robinhood', rpcOver: closed(), schedule: launchSchedule() });
  const r = await h.fx.arm(h.schedule());
  assert.equal(r.outcome, ARM.ARMED);
  assert.equal(r.fireAtMs, LAUNCH * 1000 + 50);
  const row = attempts(h.db, h.id)[0];
  assert.equal(row.status, 'armed');
  assert.equal(row.mode, 'armed');
  assert.equal(row.fire_at_ms, LAUNCH * 1000 + 50);
  assert.equal(row.launch_at, LAUNCH);
  const tx = Transaction.from(row.raw_tx);
  assert.equal(tx.hash, row.tx_hash);
  assert.equal(tx.gasLimit, 300000n, 'the estimate reverts while closed: the cap is the limit');
  assert.equal(tx.maxPriorityFeePerGas, 0n, 'FCFS chain: a tip buys nothing');
  assert.equal(tx.maxFeePerGas, 3n, '3× the base fee seen at arming time');
  assert.equal(tx.nonce, 7);
  assert.equal(tx.chainId, 4663n);
  assert.equal(h.calls.broadcast.length, 0);
});

test('fire broadcasts the armed bytes exactly once, only at its time, and never after a cancel', async () => {
  const h = harness({ chainKey: 'robinhood', rpcOver: closed(), schedule: launchSchedule() });
  await h.fx.arm(h.schedule());
  const armed = attempts(h.db, h.id)[0];
  const early = await h.fx.fire(armed, h.schedule());
  assert.equal(early.outcome, OUTCOME.WAIT);
  assert.equal(early.armed, true);
  h.setNow(LAUNCH + 1);
  const r = await h.fx.fire(armed, h.schedule());
  assert.equal(r.outcome, OUTCOME.SUBMITTED);
  assert.equal(r.txHash, armed.tx_hash);
  assert.deepEqual(h.calls.broadcast, [armed.raw_tx]);
  const sent = attempts(h.db, h.id)[0];
  assert.equal(sent.status, 'submitted');
  assert.ok(sent.fired_at_ms >= sent.fire_at_ms);
  assert.equal((await h.fx.fire(armed, h.schedule())).outcome, OUTCOME.LEASE_LOST, 'already sent: a second fire is refused');
  assert.equal(h.calls.broadcast.length, 1);

  const c = harness({ chainKey: 'robinhood', rpcOver: closed(), schedule: launchSchedule() });
  await c.fx.arm(c.schedule());
  assert.equal(cancelSchedule(c.db, c.id, 1), true, 'an armed (never sent) mint can be cancelled');
  c.setNow(LAUNCH + 1);
  assert.equal((await c.fx.fire(attempts(c.db, c.id)[0], c.schedule())).outcome, OUTCOME.LEASE_LOST);
  assert.equal(c.calls.broadcast.length, 0);
  assert.equal(attempts(c.db, c.id)[0].error, 'cancelled before it was sent');
});

test('execute on a schedule with an armed attempt fires it instead of signing again', async () => {
  const h = harness({ chainKey: 'robinhood', rpcOver: closed(), schedule: launchSchedule() });
  await h.fx.arm(h.schedule());
  h.setNow(LAUNCH);
  assert.equal((await h.fx.execute(h.schedule())).outcome, OUTCOME.WAIT, 'T itself is 50 ms before the fire time');
  h.setNow(LAUNCH + 1);
  h.rpc.simulate = async () => ({ ok: true });
  const r = await h.fx.execute(h.schedule());
  assert.equal(r.outcome, OUTCOME.SUBMITTED);
  assert.equal(attempts(h.db, h.id).length, 1, 'no second signature');
});

test('arm: open now, decoded SeaDrop errors, later stage starts, dry run and OpenSea are handled without signing', async () => {
  const open = harness({ chainKey: 'robinhood', schedule: launchSchedule() });
  assert.equal((await open.fx.arm(open.schedule())).outcome, ARM.OPEN_NOW);
  assert.equal(attempts(open.db, open.id).length, 0);

  const soldOut = harness({ chainKey: 'robinhood', rpcOver: closed(SOLD_OUT), schedule: launchSchedule() });
  const t = await soldOut.fx.arm(soldOut.schedule());
  assert.equal(t.outcome, OUTCOME.TERMINAL);
  assert.match(t.userReason, /sold out/);

  const startIn = (sec) => SEADROP_ERRORS.encodeErrorResult('NotActive', [T0 + 3600, T0 + 3600 + sec, T0 + 99999]);
  const soon = harness({ chainKey: 'robinhood', rpcOver: closed(startIn(30)), schedule: launchSchedule() });
  const s = await soon.fx.arm(soon.schedule());
  assert.equal(s.outcome, ARM.ARMED);
  assert.equal(s.chainStart, T0 + 3630);
  assert.equal(s.fireAtMs, (T0 + 3630) * 1000 + 50, 'launch mode fires at the stage start SeaDrop reports');

  const later = harness({ chainKey: 'robinhood', rpcOver: closed(startIn(600)), schedule: launchSchedule() });
  const l = await later.fx.arm(later.schedule());
  assert.equal(l.outcome, OUTCOME.WAIT);
  assert.equal(l.chainStart, T0 + 4200);
  assert.equal(l.retryAt, T0 + 4200 - 60, 'arm again one arming window before the real start');
  assert.equal(attempts(later.db, later.id).length, 0);

  const dry = harness({ chainKey: 'robinhood', automation: { dryRun: true }, rpcOver: closed(), schedule: launchSchedule() });
  assert.equal((await dry.fx.arm(dry.schedule())).outcome, ARM.NOT_ARMABLE);

  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; return new Response('{}', { status: 409 }); };
  try {
    const os = harness({ cfgOver: { openSeaApiKey: 'k' }, rpcOver: closed(), schedule: { ...launchSchedule(), preset: undefined, mintSpec: { adapter: 'opensea-drop', slug: 'drop', quantity: 1, priceWei: '1000', feeBps: 1000 }, priceWei: 1000n } });
    assert.equal((await os.fx.arm(os.schedule())).outcome, ARM.NOT_ARMABLE);
    assert.equal(fetched, 0, 'arming never spends an OpenSea API write');
  } finally { globalThis.fetch = realFetch; }
});

test('a "nonce too low" answer is checked against our own hash first: on a fast chain it may be our tx', async () => {
  const h = harness({ providerOver: { broadcastTransaction: async () => { throw Object.assign(new Error('nonce has already been used'), { code: 'NONCE_EXPIRED' }); } } });
  h.rpc.getTransaction = async (key, hash) => ({ hash });
  const r = await h.fx.execute(h.schedule());
  assert.equal(r.outcome, OUTCOME.SUBMITTED);
  assert.equal(attempts(h.db, h.id)[0].status, 'submitted');
  const lookupDown = harness({ providerOver: { broadcastTransaction: async () => { throw Object.assign(new Error('nonce has already been used'), { code: 'NONCE_EXPIRED' }); } } });
  lookupDown.rpc.getTransaction = async () => { throw new Error('rpc down'); };
  assert.equal((await lookupDown.fx.execute(lookupDown.schedule())).outcome, OUTCOME.UNCERTAIN, 'never re-sign while our own tx might exist');
});

test('a fee below the base fee is re-signed immediately with fresh fees', async () => {
  const h = harness({ providerOver: { broadcastTransaction: async () => { throw Object.assign(new Error('could not coalesce error (error={ "message": "max fee per gas less than block base fee" })'), { code: 'UNKNOWN_ERROR' }); } } });
  const r = await h.fx.execute(h.schedule());
  assert.equal(r.outcome, OUTCOME.RETRY);
  assert.equal(r.immediate, true);
  assert.equal(attempts(h.db, h.id)[0].status, 'failed');
});

test('every read before signing runs in parallel (one round trip), and signing needs no provider', async () => {
  let inFlight = 0; let maxInFlight = 0;
  const slow = (value) => async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight -= 1; return typeof value === 'function' ? value() : value; };
  const h = harness({
    rpcOver: {
      provider: async () => { throw new Error('the executor must not need a provider to sign'); },
      simulate: slow({ ok: true }), estimateGas: slow(100000n), getBalance: slow((10n ** 18n).toString()),
      getFeeInputs: slow({ baseFeePerGas: 1n, priorityFeePerGas: 0n, gasPrice: null, timestamp: T0 + 3600, number: 1 }), getNonce: slow(7)
    }
  });
  const r = await h.fx.execute(h.schedule());
  assert.equal(r.outcome, OUTCOME.SUBMITTED);
  assert.equal(maxInFlight, 5, 'simulate, estimate, balance, fees and nonce overlap');
});

test('probe: one eth_call says whether the stage is open', async () => {
  const h = harness({ chainKey: 'robinhood', rpcOver: closed(), schedule: launchSchedule() });
  const p = await h.fx.probe(h.schedule());
  assert.equal(p.outcome, OUTCOME.WAIT);
  assert.equal(p.timing, true);
  h.rpc.simulate = async () => ({ ok: true });
  assert.deepEqual(await h.fx.probe(h.schedule()), { open: true });
});

test('a node refusing the pre-signed gas cap makes the engine re-sign from an estimate instead of stopping', async () => {
  const h = harness({ chainKey: 'robinhood', rpcOver: closed(), schedule: launchSchedule() });
  await h.fx.arm(h.schedule());
  h.setNow(LAUNCH + 1);
  h.provider.broadcastTransaction = async () => { throw Object.assign(new Error('could not coalesce error (error={ "message": "intrinsic gas too low" })'), { code: 'UNKNOWN_ERROR' }); };
  const r = await h.fx.fire(attempts(h.db, h.id)[0], h.schedule());
  assert.equal(r.outcome, OUTCOME.RETRY);
  assert.equal(r.immediate, true);
  const direct = harness({ providerOver: { broadcastTransaction: async () => { throw Object.assign(new Error('intrinsic gas too low'), { code: 'UNKNOWN_ERROR' }); } } });
  assert.equal((await direct.fx.execute(direct.schedule())).outcome, OUTCOME.TERMINAL, 'an estimate-based limit refused by the node is final');
});

test('probes reuse a recent build instead of refetching provider data every 250 ms', async () => {
  let resolves = 0;
  const { resolveAndBuild } = require('../../src/core/prepareMint');
  const h = harness({ chainKey: 'robinhood', rpcOver: closed(), schedule: launchSchedule() });
  const fx = createFastExecution({ rpc: h.rpc, db: h.db, cfg: h.cfg, chains: h.chains, log: silent, now: () => T0 + 3600, resolve: (...a) => { resolves += 1; return resolveAndBuild(...a); } });
  for (let i = 0; i < 5; i++) assert.equal((await fx.probe(h.schedule())).outcome, OUTCOME.WAIT);
  assert.equal(resolves, 1);
});
