'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { T0, A, makeCfg, makeDb, addUser, addWallet, fakeTg, getChains, silent } = require('./helpers');
const { openDb } = require('../../src/db');
const { createWorker } = require('../../src/worker');
const { createSchedule, getSchedule } = require('../../src/core/schedules');
const { addTrackedTx } = require('../../src/core/tracking');
const { registerReferral } = require('../../src/core/referrals');
const { getUser } = require('../../src/core/users');
const { OUTCOME } = require('../../src/core/outcomes');
const { TelegramError } = require('../../src/telegram');

const HASH = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const flush = () => new Promise((r) => setImmediate(r));

/** Worker with a scripted executor: `results` is a function (schedule, callIndex) -> outcome object. */
/** These tests cover the tick path (late schedules, back-off, funds); the launch engine has its own suite. */
function boot({ results = () => ({ outcome: OUTCOME.SUBMITTED, txHash: HASH(1) }), rpcOver = {}, workerOver = {}, cfgOver = {} } = {}) {
  const cfg = makeCfg(cfgOver); cfg.launch = { ...cfg.launch, engine: false };
  const db = makeDb(); const chains = getChains(cfg); const tg = fakeTg(); let t = T0;
  const calls = [];
  const fastExecution = { isAvailable: () => true, isAllowed: () => true, async execute(s, opts) { calls.push({ id: s.id, opts }); return results(s, calls.length - 1); } };
  const rpc = { getReceipt: async () => null, parseReceivedTokenIds: () => [], getChainTime: async () => t, ...rpcOver };
  const w = createWorker({ db, cfg, tg, rpc, chains, fastExecution, now: () => t, log: silent, ...workerOver });
  const mk = (uid, opts = {}) => {
    if (!getUser(db, uid)) { addUser(db, uid, opts); addWallet(db, cfg, uid, A(uid)); }
    return createSchedule(db, cfg, chains, { telegramId: uid, chain: 'base', contract: A(5), preset: 'mint(uint256)', quantity: 1, priceWei: '0.01', scheduledAt: T0 + 3600, wallet: A(uid), ...opts.input }, T0);
  };
  const tick = async () => { await w.tick(); await flush(); };
  return { cfg, db, tg, w, mk, calls, tick, setNow: (x) => { t = x; } };
}

test('a due schedule is executed automatically; no signing link is ever sent', async () => {
  const b = boot();
  const id = b.mk(1);
  b.setNow(T0 + 3599); await b.tick();
  assert.equal(b.calls.length, 0);
  b.setNow(T0 + 3600); await b.tick();
  assert.equal(b.calls.length, 1);
  assert.equal(getSchedule(b.db, id).status, 'submitted');
  assert.equal(getSchedule(b.db, id).tx_hash, HASH(1));
  const texts = b.tg.texts().join('\n');
  assert.match(texts, /signed and sent/);
  assert.doesNotMatch(texts, /\/mint\?s=|Review & sign/);
  await b.tick(); await b.tick();
  assert.equal(b.calls.length, 1, 'idempotent after submission');
  assert.equal(b.tg.texts().filter((x) => /signed and sent/.test(x)).length, 1);
});

test('premium users get 10-minute and 1-minute alerts that say MintPilot signs automatically', async () => {
  const b = boot();
  b.mk(1, { premium: true });
  b.setNow(T0 + 3600 - 590); await b.tick(); await b.tick();
  b.setNow(T0 + 3600 - 50); await b.tick(); await b.tick();
  const texts = b.tg.texts();
  assert.equal(texts.length, 2);
  assert.match(texts[0], /~10 min/); assert.match(texts[1], /~1 min/);
  assert.match(texts[0], /signs automatically/);
});

test('the chain timestamp gate prevents an early local clock from triggering a mint', async () => {
  const b = boot({ rpcOver: { getChainTime: async () => T0 + 3599 } });
  const id = b.mk(1);
  b.setNow(T0 + 3600); await b.tick();
  assert.equal(b.calls.length, 0);
  assert.equal(getSchedule(b.db, id).status, 'scheduled');
});

test('RETRY keeps the schedule and backs off; the first attempts follow the tick closely', async () => {
  const b = boot({ results: () => ({ outcome: OUTCOME.RETRY, userReason: 'RPC unavailable during the mint simulation.' }) });
  const id = b.mk(1);
  for (let i = 0; i < 4; i++) { b.setNow(T0 + 3600 + i * 15); await b.tick(); }
  assert.equal(b.calls.length, 4, 'no delay for the first four attempts');
  const s = getSchedule(b.db, id);
  assert.equal(s.status, 'scheduled');
  assert.equal(s.attempts, 4);
  assert.equal(s.last_error, 'RPC unavailable during the mint simulation.');
  assert.equal(s.next_attempt_at, T0 + 3600 + 45, 'no delay yet');
  b.setNow(T0 + 3600 + 60); await b.tick();
  assert.equal(b.calls.length, 5);
  assert.equal(getSchedule(b.db, id).next_attempt_at, T0 + 3600 + 60 + 30, 'from the fifth deferral on, back off 30 s, 60 s, ...');
  b.setNow(T0 + 3600 + 75); await b.tick();
  assert.equal(b.calls.length, 5, 'still backing off');
  b.setNow(T0 + 3600 + 90); await b.tick();
  assert.equal(b.calls.length, 6);
  assert.equal(getSchedule(b.db, id).next_attempt_at, T0 + 3600 + 90 + 60);
  assert.equal(b.tg.texts().length, 0, 'transient retries are silent');
});

test('a chain-side WAIT polls every tick (no growing backoff) and resets the retry counter', async () => {
  let n = 0;
  const b = boot({ results: () => (n++ < 2 ? { outcome: OUTCOME.RETRY, userReason: 'blip' } : { outcome: OUTCOME.WAIT, userReason: 'Mint not open yet.' }) });
  const id = b.mk(1);
  for (let i = 0; i < 12; i++) { b.setNow(T0 + 3600 + i * 15); await b.tick(); }
  assert.equal(b.calls.length, 12, 'an attempt every tick while waiting for the opening');
  assert.equal(getSchedule(b.db, id).attempts, 0);
  assert.equal(b.tg.texts().length, 0, 'waiting for an opening is silent');
});

test('a WAIT that names the opening time (SeaDrop NotActive) sleeps until exactly then', async () => {
  const b = boot({ results: () => ({ outcome: OUTCOME.WAIT, userReason: 'Mint not open yet.', retryAt: T0 + 5000 }) });
  const id = b.mk(1);
  b.setNow(T0 + 3600); await b.tick();
  assert.equal(getSchedule(b.db, id).next_attempt_at, T0 + 5000);
  b.setNow(T0 + 4999); await b.tick();
  assert.equal(b.calls.length, 1);
  b.setNow(T0 + 5000); await b.tick();
  assert.equal(b.calls.length, 2);
});

test('OpenSea waits spend API writes, so they back off like retries', async () => {
  const b = boot({ results: () => ({ outcome: OUTCOME.WAIT, apiCost: true, userReason: 'OpenSea reports the drop is not minting yet.' }) });
  const id = b.mk(1);
  for (let i = 0; i < 5; i++) { b.setNow(T0 + 3600 + i * 15); await b.tick(); }
  assert.equal(getSchedule(b.db, id).attempts, 5);
  assert.equal(getSchedule(b.db, id).next_attempt_at, T0 + 3600 + 60 + 30);
});

test('Retry-After from the executor stretches the backoff', async () => {
  const b = boot({ results: () => ({ outcome: OUTCOME.RETRY, userReason: 'rate limited', retryAfterSec: 120 }) });
  const id = b.mk(1);
  b.setNow(T0 + 3600); await b.tick();
  assert.equal(getSchedule(b.db, id).next_attempt_at, T0 + 3600 + 120);
});

test('TERMINAL fails the schedule once, notifies once, and stops retrying', async () => {
  const b = boot({ results: () => ({ outcome: OUTCOME.TERMINAL, userReason: 'The contract rejected the mint: the collection is sold out for this quantity.' }) });
  const id = b.mk(1);
  b.setNow(T0 + 3600); await b.tick(); await b.tick();
  const s = getSchedule(b.db, id);
  assert.equal(s.status, 'failed');
  assert.match(s.last_error, /sold out/);
  assert.equal(b.calls.length, 1);
  assert.equal(b.tg.texts().filter((x) => /stopped/.test(x)).length, 1);
});

test('insufficient funds sends exactly one top-up notice while the schedule keeps waiting', async () => {
  const b = boot({ results: () => ({ outcome: OUTCOME.WAIT, notify: 'funds', userReason: 'Wallet balance 0 ETH is below the mint value 0.01 ETH.' }) });
  const id = b.mk(1);
  for (let i = 0; i < 3; i++) { b.setNow(T0 + 3600 + i * 15); await b.tick(); }
  assert.equal(getSchedule(b.db, id).status, 'scheduled');
  const notices = b.tg.texts().filter((x) => /below the mint value/.test(x));
  assert.equal(notices.length, 1);
  assert.match(notices[0], /keeps trying until/);
});

test('UNCERTAIN is re-checked after 30 s with a single notice; a later SUBMITTED is recorded', async () => {
  let n = 0;
  const b = boot({ results: () => (n++ === 0 ? { outcome: OUTCOME.UNCERTAIN, userReason: 'Broadcast result unknown.', txHash: HASH(9) } : { outcome: OUTCOME.SUBMITTED, txHash: HASH(9), reconciled: true }) });
  const id = b.mk(1);
  b.setNow(T0 + 3600); await b.tick();
  assert.equal(getSchedule(b.db, id).next_attempt_at, T0 + 3630);
  b.setNow(T0 + 3615); await b.tick();
  assert.equal(b.calls.length, 1);
  b.setNow(T0 + 3630); await b.tick();
  assert.equal(getSchedule(b.db, id).status, 'submitted');
  assert.equal(b.tg.texts().filter((x) => /Broadcast result unknown/.test(x)).length, 1);
});

test('dry run completes the schedule as "ready" with the report, and expires later (review #5)', async () => {
  const b = boot({ results: () => ({ outcome: OUTCOME.DRY_RUN, userReason: 'Dry run passed: would send 0.01 ETH.' }) });
  const id = b.mk(1);
  b.setNow(T0 + 3600); await b.tick(); await b.tick();
  assert.equal(getSchedule(b.db, id).status, 'ready');
  assert.equal(b.calls.length, 1);
  assert.match(b.tg.texts()[0], /Dry run passed/);
  b.setNow(T0 + 3600 + 6 * 3600 + 1); await b.tick();
  assert.equal(getSchedule(b.db, id).status, 'expired');
});

test('schedules expire at their deadline with one notice; a launch window end uses chain time', async () => {
  const b = boot({ results: () => ({ outcome: OUTCOME.WAIT, userReason: 'Mint not open yet.' }) });
  const manual = b.mk(1);
  b.setNow(T0 + 3600); await b.tick();
  b.setNow(T0 + 3600 + 21601); await b.tick(); await b.tick();
  assert.equal(getSchedule(b.db, manual).status, 'expired');
  assert.equal(b.tg.texts().filter((x) => /expired/.test(x)).length, 1);
  assert.match(b.tg.texts().find((x) => /expired/.test(x)), /Last status: Mint not open yet/);

  const c = boot({ results: () => ({ outcome: OUTCOME.WAIT, userReason: 'not open' }) });
  const launch = c.mk(2, { input: { triggerMode: 'launch', scheduledAt: T0, launchAt: T0 + 100, endAt: T0 + 200 } });
  c.setNow(T0 + 150); await c.tick();
  assert.equal(c.calls.length, 1);
  c.setNow(T0 + 201); await c.tick();
  assert.equal(getSchedule(c.db, launch).status, 'expired');
  assert.equal(c.calls.length, 1);
});

test('a schedule with an open signed attempt is not expired or cancelled; it is left to reconciliation', async () => {
  const b = boot({ results: () => ({ outcome: OUTCOME.UNCERTAIN, userReason: 'unknown', txHash: HASH(3) }) });
  const id = b.mk(1);
  b.db.prepare("INSERT INTO execution_attempts (schedule_id, chain, wallet_address, status, tx_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(id, 'base', A(1), 'uncertain', HASH(3), T0, T0);
  b.setNow(T0 + 3600 + 21601); await b.tick();
  assert.equal(getSchedule(b.db, id).status, 'scheduled');
  const { cancelSchedule } = require('../../src/core/schedules');
  assert.equal(cancelSchedule(b.db, id, 1), false);
});

test('schedules for users who blocked the bot still execute; only alerts are skipped', async () => {
  const b = boot();
  const id = b.mk(3, { premium: true });
  b.db.prepare('UPDATE users SET blocked_bot=1 WHERE telegram_id=?').run('3');
  b.setNow(T0 + 3000); await b.tick();
  assert.equal(b.tg.calls.length, 0);
  b.setNow(T0 + 3600); await b.tick();
  assert.equal(getSchedule(b.db, id).status, 'submitted');
});

test('telegram 403 marks the user as blocked', async () => {
  const b = boot();
  b.mk(4);
  b.tg.sendMessage = async () => { throw new TelegramError('sendMessage', 403, 'blocked'); };
  b.setNow(T0 + 3600); await b.tick();
  assert.equal(b.db.prepare('SELECT blocked_bot FROM users WHERE telegram_id=4').get().blocked_bot, 1);
});

test('automatic schedules run concurrently across wallets but serialize per wallet', async () => {
  let active = 0; let maxActive = 0;
  const activeByWallet = new Map(); const maxByWallet = new Map();
  const results = async (schedule) => {
    const wallet = schedule.wallet_address.toLowerCase();
    active += 1; activeByWallet.set(wallet, (activeByWallet.get(wallet) || 0) + 1);
    maxActive = Math.max(maxActive, active);
    maxByWallet.set(wallet, Math.max(maxByWallet.get(wallet) || 0, activeByWallet.get(wallet)));
    await new Promise((resolve) => setTimeout(resolve, 25));
    activeByWallet.set(wallet, activeByWallet.get(wallet) - 1); active -= 1;
    return { outcome: OUTCOME.SUBMITTED, txHash: HASH(schedule.id) };
  };
  const b = boot({ results, workerOver: { maxConcurrentWallets: 2 } });
  const ids = [b.mk(1), b.mk(1), b.mk(2), b.mk(3)];
  b.setNow(T0 + 3600); await b.tick();
  assert.equal(maxActive, 2);
  assert.equal(maxByWallet.get(A(1)), 1);
  for (const id of ids) assert.equal(getSchedule(b.db, id).status, 'submitted');
});

test('separate worker instances sharing SQLite cannot execute the same wallet concurrently', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintpilot-worker-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mintpilot.sqlite');
  const db1 = openDb(file); const db2 = openDb(file);
  t.after(() => { db1.close(); db2.close(); });
  const cfg = makeCfg(); const chains = getChains(cfg);
  addUser(db1, 91); addWallet(db1, cfg, 91, A(91));
  const scheduleId = createSchedule(db1, cfg, chains, { telegramId: 91, chain: 'base', contract: A(5), preset: 'mint(uint256)', quantity: 1, priceWei: '0.01', scheduledAt: T0 + 3600, wallet: A(91) }, T0);
  let active = 0; let calls = 0; let maxActive = 0;
  const fastExecution = {
    async execute() {
      calls += 1; active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return { outcome: OUTCOME.SUBMITTED, txHash: HASH(77) };
    }
  };
  const rpc = { getReceipt: async () => null, parseReceivedTokenIds: () => [] };
  // Launch engine on: each instance starts a session; the durable wallet lease admits exactly one.
  // The engine sleeps on real timers, so this test's clock moves with real time from the opening.
  cfg.launch = { ...cfg.launch, receiptWatchSec: 0 };
  const startedAt = Date.now();
  const nowMs = () => (T0 + 3600) * 1000 + (Date.now() - startedAt);
  const worker = (db) => createWorker({ db, cfg, tg: fakeTg(), rpc, chains, fastExecution, nowMs, log: silent });
  const [w1, w2] = [worker(db1), worker(db2)];
  await Promise.all([w1.tick(), w2.tick()]);
  await Promise.all([w1.idle(), w2.idle()]);
  assert.equal(calls, 1);
  assert.equal(maxActive, 1);
  assert.equal(getSchedule(db1, scheduleId).status, 'submitted');
});

test('tracking: confirmed tx updates schedule, reports minted token ids, notifies once', async () => {
  const hash = '0x' + 'ab'.repeat(32);
  const b = boot({ rpcOver: { getReceipt: async () => ({ status: 'confirmed', blockNumber: 123, confirmations: 3, logs: [] }), parseReceivedTokenIds: (logs, wallets) => (wallets[0] === A(1) ? ['41', '42'] : []) } });
  const id = b.mk(1);
  b.db.prepare("UPDATE schedules SET status='submitted', tx_hash=? WHERE id=?").run(hash, id);
  addTrackedTx(b.db, b.cfg, { telegramId: 1, chain: 'base', txHash: hash, scheduleId: id, system: true }, T0);
  await b.tick(); await b.tick();
  assert.equal(getSchedule(b.db, id).status, 'confirmed');
  const t = b.tg.texts().filter((x) => /confirmed/.test(x));
  assert.equal(t.length, 1); assert.match(t[0], /41, 42/); assert.match(t[0], /basescan\.org\/tx\//);
  assert.deepEqual(JSON.parse(b.db.prepare('SELECT token_ids FROM tracked_txs').get().token_ids), ['41', '42']);
});

test('tracking: reverted tx is reported as failed; waits for required confirmations; drops after 24h', async () => {
  const h = (n) => '0x' + String(n).repeat(64).slice(0, 64);
  let receipt = { status: 'failed', blockNumber: 9, confirmations: 1, logs: [] };
  const b = boot({ rpcOver: { getReceipt: async (chain, hash) => (hash === h(3) ? null : receipt) } });
  addUser(b.db, 1);
  addTrackedTx(b.db, b.cfg, { telegramId: 1, chain: 'base', txHash: h(1) }, T0);
  addTrackedTx(b.db, b.cfg, { telegramId: 1, chain: 'ethereum', txHash: h(2) }, T0);
  addTrackedTx(b.db, b.cfg, { telegramId: 1, chain: 'base', txHash: h(3) }, T0);
  b.setNow(T0 + 60); await b.tick();
  const st = (n) => b.db.prepare('SELECT status FROM tracked_txs WHERE tx_hash=?').get(h(n)).status;
  assert.equal(st(1), 'failed'); assert.equal(st(2), 'pending'); assert.equal(st(3), 'pending');
  receipt = { ...receipt, confirmations: 2 };
  b.setNow(T0 + 24 * 3600 + 120); await b.tick();
  assert.equal(st(2), 'failed'); assert.equal(st(3), 'dropped');
  assert.ok(b.tg.texts().some((x) => /dropped or replaced/.test(x)));
});

test('referral rewards are paid on the referee\'s first confirmed mint, once (review #11)', async () => {
  const hash = '0x' + 'cd'.repeat(32);
  const b = boot({ rpcOver: { getReceipt: async () => ({ status: 'confirmed', blockNumber: 5, confirmations: 3, logs: [] }) } });
  const referrer = addUser(b.db, 50);
  const id = b.mk(51);
  assert.equal(registerReferral(b.db, 51, referrer.ref_code, T0), true);
  b.db.prepare("UPDATE schedules SET status='submitted', tx_hash=? WHERE id=?").run(hash, id);
  addTrackedTx(b.db, b.cfg, { telegramId: 51, chain: 'base', txHash: hash, scheduleId: id, system: true }, T0);
  b.setNow(T0 + 10); await b.tick(); await b.tick();
  assert.ok(getUser(b.db, 50).premium_until > T0);
  assert.ok(getUser(b.db, 51).premium_until > T0);
  assert.equal(b.db.prepare("SELECT status FROM referrals WHERE referee_id='51'").get().status, 'rewarded');
  assert.equal(b.tg.texts().filter((x) => /completed their first mint/.test(x)).length, 1);
});
