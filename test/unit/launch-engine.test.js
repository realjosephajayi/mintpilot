'use strict';
// Launch engine end-to-end: real worker + real executor + real signing, against a simulated chain whose
// block timestamps follow a virtual millisecond clock. A transaction is "mined" INCLUSION_MS after it is
// broadcast; it succeeds only if that block's timestamp (whole seconds) is at or after the stage start,
// which is exactly how SeaDrop and timestamp-gated contracts decide. Sleeping advances the virtual clock,
// so a 60 s arming window runs in milliseconds and every timing assertion is exact.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Transaction } = require('ethers');
const { T0, A, makeCfg, makeDb, addUser, addSignableWallet, fakeTg, getChains, silent } = require('./helpers');
const { createWorker } = require('../../src/worker');
const { createFastExecution } = require('../../src/core/fastExecution');
const { createSchedule, getSchedule, cancelSchedule } = require('../../src/core/schedules');
const { SEADROP_ERRORS } = require('../../src/core/outcomes');

const LAUNCH = T0 + 3600;
const INCLUSION_MS = 100; // Robinhood Chain: ~100 ms blocks
const flush = () => new Promise((r) => setImmediate(r));

function rig({ startSec = LAUNCH, seaDropNotActive = false, launchOver = {}, automation = {}, balance = 10n ** 18n } = {}) {
  const cfg = makeCfg();
  cfg.automation = { ...cfg.automation, walletLockTtlSec: 900, ...automation };
  cfg.launch = { ...cfg.launch, ...launchOver };
  const chains = getChains(cfg);
  const db = makeDb(); const tg = fakeTg();
  let tMs = (LAUNCH - 55) * 1000;
  const events = [];
  const clock = {
    nowMs: () => tMs,
    set: (sec) => { tMs = sec * 1000; },
    at: (ms, fn) => events.push({ ms, fn }),
    async sleep(ms) {
      tMs += Math.max(0, ms);
      for (const e of events.filter((x) => !x.done && x.ms <= tMs)) { e.done = true; await e.fn(); }
      await flush();
    }
  };
  const chain = {
    startSec, balance, nonce: 0, revertAlways: false, broadcasts: [], txs: new Map(), warms: 0, simulations: 0,
    open: () => Math.floor(tMs / 1000) >= chain.startSec,
    revertData: () => (seaDropNotActive ? SEADROP_ERRORS.encodeErrorResult('NotActive', [Math.floor(tMs / 1000), chain.startSec, chain.startSec + 99999]) : '0x')
  };
  const rpc = {
    async simulate() { chain.simulations += 1; return chain.open() ? { ok: true } : { ok: false, reason: 'execution reverted', data: chain.revertData() }; },
    async estimateGas() { if (!chain.open()) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: chain.revertData() }); return 90000n; },
    async getBalance() { return chain.balance.toString(); },
    async getFeeInputs() { return { baseFeePerGas: 10_000_000n, priorityFeePerGas: null, gasPrice: null, timestamp: Math.floor(tMs / 1000), number: 1 }; },
    async getNonce() { return chain.nonce; },
    async getChainTime() { return Math.floor(tMs / 1000); },
    async getAllowedSeaDrop() { return []; },
    async warm() { chain.warms += 1; return 1; },
    async broadcast(key, raw) {
      const tx = Transaction.from(raw);
      if (tx.nonce < chain.nonce) throw Object.assign(new Error('nonce has already been used'), { code: 'NONCE_EXPIRED' });
      const includedAtMs = tMs + INCLUSION_MS;
      const blockTs = Math.floor(includedAtMs / 1000);
      const status = blockTs >= chain.startSec && !chain.revertAlways ? 1 : 0;
      const rec = { raw, hash: tx.hash, nonce: tx.nonce, atMs: tMs, includedAtMs, blockTs, status, block: 1000 + chain.broadcasts.length, tx };
      chain.broadcasts.push(rec); chain.txs.set(tx.hash, rec);
      chain.nonce += 1; // reverted transactions consume their nonce too
      return { hash: tx.hash, ackMs: 3, host: 'sequencer' };
    },
    async getTransaction(key, hash) { return chain.txs.has(hash) ? { hash } : null; },
    async getReceipt(key, hash) {
      const rec = chain.txs.get(hash);
      if (!rec || tMs < rec.includedAtMs) return null;
      return { status: rec.status === 1 ? 'confirmed' : 'failed', blockNumber: rec.block, confirmations: 1, logs: [], gasUsed: '85000' };
    },
    async getBlockTimestamp(key, n) { const rec = chain.broadcasts.find((b) => b.block === Number(n)); return rec ? rec.blockTs : null; },
    parseReceivedTokenIds: () => []
  };
  const fastExecution = createFastExecution({ rpc, db, cfg, chains, log: silent, nowMs: clock.nowMs });
  const worker = createWorker({ db, cfg, tg, rpc, chains, fastExecution, nowMs: clock.nowMs, sleep: clock.sleep, log: silent });
  addUser(db, 1);
  const wallet = addSignableWallet(db, cfg, 1);
  const id = createSchedule(db, cfg, chains, { telegramId: 1, chain: 'robinhood', contract: A(5), preset: 'mint(uint256)', quantity: 1, priceWei: '0.001', triggerMode: 'launch', launchAt: LAUNCH, scheduledAt: LAUNCH - 3600, wallet: wallet.address }, LAUNCH - 3600);
  const run = async (w = worker) => { await w.tick(); await w.idle(); await flush(); await flush(); };
  const attempts = () => db.prepare('SELECT * FROM execution_attempts WHERE schedule_id=? ORDER BY id').all(id);
  return { cfg, chains, db, tg, rpc, chain, clock, worker, fastExecution, wallet, id, run, attempts, schedule: () => getSchedule(db, id) };
}

test('armed ahead of time and broadcast at exactly T + 50 ms; lands in the opening second', async () => {
  const r = rig();
  await r.run();
  assert.equal(r.chain.broadcasts.length, 1);
  const sent = r.chain.broadcasts[0];
  assert.equal(sent.atMs, LAUNCH * 1000 + 50, 'fired on the millisecond timer, not on a worker tick');
  assert.equal(sent.blockTs, LAUNCH);
  assert.equal(sent.tx.maxPriorityFeePerGas, 0n);
  assert.equal(sent.tx.gasLimit, 300000n);
  assert.equal(r.chain.warms, 1, 'RPC connections warmed before the fire time');
  const a = r.attempts()[0];
  assert.equal(a.mode, 'armed');
  assert.equal(a.fired_at_ms - a.fire_at_ms, 0);
  assert.equal(a.included_at, LAUNCH);
  assert.equal(a.gas_used, 85000);
  assert.equal(r.schedule().status, 'confirmed');
  const texts = r.tg.texts().join('\n');
  assert.match(texts, /pre-signed and armed/);
  assert.match(texts, /signed and sent/);
  assert.match(texts, /Landed in the opening second \(pre-signed\)/);
});

test('bad timing: the mint reverts on-chain, is re-signed with a fresh nonce and lands the moment the stage opens', async () => {
  // The user's opening time is one second early; the contract gives no start time to decode.
  const r = rig({ startSec: LAUNCH + 1 });
  await r.run();
  assert.equal(r.chain.broadcasts.length, 2);
  const [first, second] = r.chain.broadcasts;
  assert.equal(first.status, 0, 'first attempt reverted (block timestamp before the start)');
  assert.equal(second.status, 1);
  assert.equal(second.nonce, first.nonce + 1, 'fresh nonce');
  assert.ok(second.atMs >= (LAUNCH + 1) * 1000, 'never sent before the stage opened');
  assert.ok(second.atMs - (LAUNCH + 1) * 1000 <= r.cfg.launch.retryIntervalMs, `retried within one probe interval of the opening (${second.atMs - (LAUNCH + 1) * 1000} ms)`);
  assert.equal(second.blockTs, LAUNCH + 1, 'landed in the opening second');
  assert.equal(r.schedule().status, 'confirmed');
  assert.equal(r.schedule().chain_retries, 1);
  assert.deepEqual(r.attempts().map((a) => [a.status, a.error]), [['failed', 'reverted on-chain'], ['reconciled', null]]);
  const texts = r.tg.texts().join('\n');
  assert.match(texts, /reverted on-chain .*re-signing and sending again now \(retry 1 of 3\)/);
  assert.match(texts, /Retry 1: mint for schedule #\d+ re-signed and sent/);
});

test('a revert that is seen on the receipt is retried within one receipt poll', async () => {
  // Open at T, but the first transaction reverts anyway (e.g. out of gas); the second succeeds.
  const r = rig();
  r.chain.revertAlways = true;
  r.clock.at(LAUNCH * 1000 + 60, () => { r.chain.revertAlways = false; });
  await r.run();
  const [first, second] = r.chain.broadcasts;
  assert.equal(first.status, 0);
  assert.equal(second.status, 1);
  const seenAt = first.includedAtMs;
  assert.ok(second.atMs - seenAt <= r.cfg.launch.receiptPollMs, `re-sent ${second.atMs - seenAt} ms after the revert was mined`);
  assert.equal(second.tx.gasLimit, 112500n, 'the retry uses a fresh estimate (×1.25), not the cap');
});

test('on-chain re-signs stop at LAUNCH_MAX_CHAIN_RETRIES', async () => {
  const r = rig();
  r.chain.revertAlways = true;
  await r.run();
  assert.equal(r.chain.broadcasts.length, 4, 'first send + 3 re-signs');
  assert.equal(r.schedule().status, 'failed');
  assert.equal(r.schedule().chain_retries, 3);
  assert.match(r.tg.texts().join('\n'), /already re-signed it 3 time\(s\) and stopped/);
});

test('SeaDrop reports a later stage start: the schedule follows it and fires at that start', async () => {
  const r = rig({ startSec: LAUNCH + 20, seaDropNotActive: true });
  await r.run();
  assert.equal(r.chain.broadcasts.length, 0, 'first session only learns the real start (75 s away)');
  assert.equal(r.schedule().launch_at, LAUNCH + 20);
  assert.equal(r.schedule().next_attempt_at, LAUNCH + 20 - 60);
  r.clock.set(LAUNCH + 20 - 60);
  await r.run();
  assert.equal(r.chain.broadcasts.length, 1);
  assert.equal(r.chain.broadcasts[0].atMs, (LAUNCH + 20) * 1000 + 50);
  assert.equal(r.schedule().status, 'confirmed');
});

test('the stage opens 3 s late: probes every 250 ms and sends in the opening second; with no re-sign budget a revert is final', async () => {
  const r = rig({ startSec: LAUNCH + 3 });
  await r.run();
  const [first, last] = [r.chain.broadcasts[0], r.chain.broadcasts.at(-1)];
  assert.equal(r.chain.broadcasts.length, 2);
  assert.equal(first.status, 0);
  assert.equal(last.status, 1);
  assert.ok(last.atMs >= (LAUNCH + 3) * 1000 && last.atMs - (LAUNCH + 3) * 1000 <= r.cfg.launch.retryIntervalMs);
  assert.equal(last.blockTs, LAUNCH + 3);
  assert.ok(r.chain.simulations >= 8, 'cheap eth_call probes while closed, not full sends');

  const none = rig({ startSec: LAUNCH + 3, launchOver: { maxChainRetries: 0 } });
  await none.run();
  assert.equal(none.chain.broadcasts.length, 1);
  assert.equal(none.schedule().status, 'failed');
});

test('cancel while armed: nothing is ever broadcast', async () => {
  const r = rig();
  r.clock.at((LAUNCH - 10) * 1000, () => { assert.equal(cancelSchedule(r.db, r.id, 1), true); });
  await r.run();
  assert.equal(r.chain.broadcasts.length, 0);
  assert.equal(r.schedule().status, 'cancelled');
  assert.equal(r.attempts()[0].status, 'failed');
});

test('a restarted worker fires the already-armed bytes; it never signs a second transaction', async () => {
  const r = rig();
  r.clock.at((LAUNCH - 30) * 1000, () => { r.worker.stop(); });
  await r.run();
  assert.equal(r.chain.broadcasts.length, 0);
  const armed = r.attempts()[0];
  assert.equal(armed.status, 'armed');
  const fx2 = createFastExecution({ rpc: r.rpc, db: r.db, cfg: r.cfg, chains: r.chains, log: silent, nowMs: r.clock.nowMs });
  const w2 = createWorker({ db: r.db, cfg: r.cfg, tg: r.tg, rpc: r.rpc, chains: r.chains, fastExecution: fx2, nowMs: r.clock.nowMs, sleep: r.clock.sleep, log: silent });
  await r.run(w2);
  assert.equal(r.chain.broadcasts.length, 1);
  assert.equal(r.chain.broadcasts[0].raw, armed.raw_tx, 'identical signed bytes');
  assert.equal(r.chain.broadcasts[0].atMs, armed.fire_at_ms);
  assert.equal(r.attempts().length, 1);
  assert.equal(r.schedule().status, 'confirmed');
});

test('short of funds at arming: one notice, re-armed after the top-up, still fired on time', async () => {
  const r = rig({ balance: 0n });
  r.clock.at((LAUNCH - 20) * 1000, () => { r.chain.balance = 10n ** 18n; });
  await r.run();
  assert.equal(r.chain.broadcasts.length, 1);
  assert.equal(r.chain.broadcasts[0].atMs, LAUNCH * 1000 + 50);
  assert.equal(r.tg.texts().filter((x) => /💸/.test(x)).length, 1);
  assert.equal(r.schedule().status, 'confirmed');
});

test('dry run: nothing is pre-signed; at T every check runs and the schedule is reported ready', async () => {
  const r = rig({ automation: { dryRun: true } });
  await r.run();
  assert.equal(r.chain.broadcasts.length, 0);
  assert.equal(r.attempts().length, 0);
  assert.equal(r.schedule().status, 'ready');
  assert.match(r.tg.texts().join('\n'), /Dry run passed/);
});

test('LAUNCH_ENGINE=false keeps the v2.1 tick path', async () => {
  const r = rig({ launchOver: { engine: false } });
  await r.run();
  assert.equal(r.chain.broadcasts.length, 0, 'before T the tick does nothing');
  r.clock.set(LAUNCH);
  await r.run();
  assert.equal(r.chain.broadcasts.length, 1);
  assert.equal(r.attempts()[0].mode, 'direct');
});
