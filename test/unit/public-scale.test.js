'use strict';
// Mass-usage behaviour: concurrent update handling, outbound pacing, RPC priority lanes, non-blocking
// custody crypto, cached ABI discovery, health/metrics, release gate, per-chain gas caps.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('ethers');
const { createPoller, chatKeyOf } = require('../../src/bot/poller');
const { createPacer, TelegramError } = require('../../src/telegram');
const { createRateLimiter, withRpcPriority } = require('../../src/core/rpc');
const { sealAsync, getCustodialPrivateKeyAsync, getCustodialPrivateKey, seal, ensurePlatformWalletAsync } = require('../../src/core/custodialWallets');
const { createAbiSources } = require('../../src/core/abiSources');
const { createHealth } = require('../../src/core/health');
const { audit } = require('../../scripts/release');
const { gasCap, gasLimitFor } = require('../../src/core/gasPolicy');
const { makeCfg, makeDb, addUser, silent, TEST_MASTER_KEY } = require('./helpers');

const flush = () => new Promise((r) => setImmediate(r));
const msg = (id, chat, text = 'x') => ({ update_id: id, message: { message_id: id, chat: { id: chat, type: 'private' }, from: { id: chat }, text } });

function pollerHarness({ handle, maxConcurrent = 8, updates = [], onError = null }) {
  const db = makeDb();
  let served = false;
  const tg = {
    deleteWebhook: async () => {},
    getUpdates: async (p, { signal }) => {
      if (!served) { served = true; return updates; }
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
  };
  const poller = createPoller({ tg, db, handler: { handleUpdate: handle }, log: silent, maxConcurrent, onError, sleep: async () => {} });
  return { db, poller };
}

test('poller: one slow chat never blocks others; each chat is handled strictly in order', async () => {
  const order = [];
  let releaseSlow;
  const slow = new Promise((r) => { releaseSlow = r; });
  const handle = async (u) => {
    order.push(`start:${u.update_id}`);
    if (u.update_id === 1) await slow; // chat 100 is stuck on an RPC call
    order.push(`end:${u.update_id}`);
  };
  const { poller, db } = pollerHarness({ handle, updates: [msg(1, 100), msg(2, 100), msg(3, 200), msg(4, 300)] });
  poller.run();
  for (let i = 0; i < 10; i++) await flush();
  assert.ok(order.includes('end:3') && order.includes('end:4'), 'other chats finished while chat 100 waits');
  assert.ok(!order.includes('start:2'), 'chat 100 update 2 waits for update 1');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tg_inbox').get().n, 2, 'unfinished updates stay in the durable inbox');
  assert.equal(db.prepare("SELECT value FROM kv WHERE key='tg_offset'").get().value, '5');
  releaseSlow();
  await poller.drain(1000);
  assert.ok(order.indexOf('end:1') < order.indexOf('start:2'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tg_inbox').get().n, 0);
  poller.stop();
});

test('poller: concurrency is bounded; payment pre-checkout skips every queue; failures reach onError', async () => {
  let active = 0; let peak = 0; const errors = [];
  const handle = async (u) => {
    if (u.update_id === 9) throw new Error('boom');
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
  };
  const updates = Array.from({ length: 8 }, (_, i) => msg(i + 1, 1000 + i));
  updates.push(msg(9, 5000));
  updates.push({ update_id: 10, pre_checkout_query: { id: 'q', from: { id: 1000 } } });
  const { poller } = pollerHarness({ handle, maxConcurrent: 3, updates, onError: (u) => errors.push(u.update_id) });
  poller.run();
  await flush(); await flush();
  await poller.drain(2000);
  assert.ok(peak <= 4, `peak ${peak}: 3 queued slots + the pre-checkout lane`);
  assert.deepEqual(errors, [9]);
  assert.equal(chatKeyOf({ update_id: 1, callback_query: { from: { id: 7 }, message: { chat: { id: 8 } } } }), '8');
  poller.stop();
});

test('poller: a restart replays unfinished updates from the inbox and drops stale or poisoned ones', async () => {
  const db = makeDb();
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare('INSERT INTO tg_inbox (update_id, chat_key, kind, payload, received_at, attempts) VALUES (?,?,?,?,?,?)');
  ins.run(1, '1', 'message', JSON.stringify(msg(1, 1)), now, 0);
  ins.run(2, '2', 'message', JSON.stringify(msg(2, 2)), now - 3600, 0);   // too old
  ins.run(3, '3', 'message', JSON.stringify(msg(3, 3)), now, 3);          // failed 3 times
  ins.run(4, '4', 'pre_checkout', JSON.stringify({ update_id: 4, pre_checkout_query: { id: 'q' } }), now, 0); // 10 s answer window long gone
  const seen = [];
  const tg = { deleteWebhook: async () => {}, getUpdates: (p, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) };
  const poller = createPoller({ tg, db, handler: { handleUpdate: async (u) => { seen.push(u.update_id); } }, log: silent, sleep: async () => {} });
  poller.run();
  await flush(); await poller.drain(1000);
  assert.deepEqual(seen, [1]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tg_inbox').get().n, 0);
  poller.stop();
});

test('poller: 409 Conflict (second instance) is reported and backed off, not spun on', async () => {
  const db = makeDb(); const errors = []; const sleeps = [];
  let calls = 0;
  let poller;
  const tg = {
    deleteWebhook: async () => {},
    getUpdates: async () => { calls += 1; if (calls >= 2) poller.stop(); throw new TelegramError('getUpdates', 409, 'Conflict: terminated by other getUpdates request'); }
  };
  poller = createPoller({ tg, db, handler: { handleUpdate: async () => {} }, log: { ...silent, error: (m) => errors.push(String(m)) }, sleep: async (ms) => { sleeps.push(ms); } });
  await poller.run();
  assert.match(errors[0], /409 Conflict/);
  assert.equal(sleeps[0], 10_000);
  assert.ok(poller.stats().lastConflictAt);
});

test('pacer: per-chat order and burst limit, round-robin fairness, and a 429 pauses every chat then retries', async () => {
  let t = 0;
  const pacer = createPacer({ globalPerSecond: 25, perChatIntervalMs: 1000, perChatBurst: 2, now: () => t, sleep: async (ms) => { t += ms; } });
  const log = [];
  let tripped = false;
  const jobs = [
    ...[0, 1, 2, 3].map((i) => pacer.schedule('A', async () => { log.push(['A', i, t]); })),
    pacer.schedule('B', async () => { if (!tripped) { tripped = true; throw new TelegramError('sendMessage', 429, 'Too Many Requests', { retry_after: 3 }); } log.push(['B', 0, t]); })
  ];
  await Promise.all(jobs);
  const a = log.filter((x) => x[0] === 'A');
  assert.deepEqual(a.map((x) => x[1]), [0, 1, 2, 3], 'chat order preserved');
  assert.ok(a[2][2] >= 1000, 'third message to one chat waits for the per-chat bucket');
  const b = log.find((x) => x[0] === 'B');
  assert.ok(b[2] >= 3000, 'retried after retry_after');
  await assert.rejects(pacer.schedule('C', async () => { throw new TelegramError('sendMessage', 403, 'blocked'); }), (e) => e.blocked);
});

test('RPC limiter: when the bucket is empty, high-priority (launch) reads go before normal and low (polling) reads', async () => {
  let t = 0;
  const limiter = createRateLimiter({ ratePerSecond: 1, burst: 1, now: () => t, sleep: async (ms) => { t += ms; } });
  await limiter.acquire(); // drain the bucket
  const order = [];
  const low = withRpcPriority('low', () => limiter.acquire().then(() => order.push('low')));
  const normal = limiter.acquire().then(() => order.push('normal'));
  const high = withRpcPriority('high', () => limiter.acquire().then(() => order.push('high')));
  await Promise.all([low, normal, high]);
  assert.deepEqual(order, ['high', 'normal', 'low']);
});

test('custody: async seal/open round-trips, matches the sync format, caches the derived key, and provisions once per user', async () => {
  const cfg = makeCfg();
  const w = Wallet.createRandom();
  const sealed = await sealAsync(w.privateKey, TEST_MASTER_KEY);
  const row = { id: 1, address: w.address.toLowerCase(), ciphertext: sealed.ciphertext, iv: sealed.iv, auth_tag: sealed.authTag, salt: sealed.salt };
  assert.equal((await getCustodialPrivateKeyAsync(row, cfg)).privateKey, w.privateKey);
  assert.equal(getCustodialPrivateKey(row, cfg).privateKey, w.privateKey, 'sync path reads async-sealed keys');
  const legacy = seal(w.privateKey, TEST_MASTER_KEY);
  assert.equal((await getCustodialPrivateKeyAsync({ ...row, ...legacy, auth_tag: legacy.authTag }, cfg)).privateKey, w.privateKey, 'async path reads sync-sealed keys');
  const started = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) await getCustodialPrivateKeyAsync(row, cfg);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 200, 'derived key is cached (no scrypt per decrypt)');
  await assert.rejects(getCustodialPrivateKeyAsync(row, { automation: { encryptionKey: 'bb'.repeat(32) } }), /could not be decrypted/);
  const db = makeDb(); addUser(db, 42);
  const [a, b] = await Promise.all([ensurePlatformWalletAsync(db, cfg, 42, 1), ensurePlatformWalletAsync(db, cfg, 42, 1)]);
  assert.equal(a.address, b.address);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM wallets WHERE telegram_id='42' AND wallet_type='platform'").get().n, 1);
});

test('ABI sources: Blockscout, then Sourcify, then Etherscan (only with a key); cached and de-duplicated; bounded', async () => {
  const chain = { chainId: 8453, abiApi: 'https://base.blockscout.com' };
  const abi = [{ type: 'function', name: 'mint', inputs: [] }];
  const calls = [];
  const respond = (body, ok = true) => ({ ok, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, opts) => {
    calls.push(String(url));
    assert.equal(opts.redirect, 'error');
    if (url.includes('blockscout')) return respond({ message: 'Not found' }, false);
    if (url.includes('sourcify')) return respond({ abi });
    return respond({ status: '0' });
  };
  const sources = createAbiSources({ fetchImpl });
  const [r1, r2] = await Promise.all([sources.verifiedAbi(chain, '0xAbC'), sources.verifiedAbi(chain, '0xabc')]);
  assert.equal(r1.source, 'sourcify'); assert.equal(r2.source, 'sourcify');
  assert.deepEqual(calls.map((u) => new URL(u).host), ['base.blockscout.com', 'sourcify.dev'], 'one lookup for concurrent callers, no Etherscan without a key');
  await sources.verifiedAbi(chain, '0xabc');
  assert.equal(calls.length, 2, 'cached');
  const withKey = createAbiSources({ etherscanApiKey: 'K', fetchImpl: async (url) => (String(url).includes('etherscan') ? respond({ status: '1', result: JSON.stringify(abi) }) : respond({}, false)) });
  assert.equal((await withKey.verifiedAbi({ chainId: 1, abiApi: null }, '0x1')).source, 'etherscan');
  const huge = createAbiSources({ fetchImpl: async () => ({ ok: true, headers: { get: () => String(50 * 1024 * 1024) }, text: async () => '[]' }) });
  assert.equal(await huge.verifiedAbi(chain, '0x2'), null);
});

test('health: readiness fails on a stale worker tick; metrics expose queue depths and open attempts without user data', () => {
  const db = makeDb();
  const cfg = makeCfg();
  let now = 1_000_000;
  const worker = { stats: () => ({ lastTickAt: now - 600_000, lastTickMs: 12, tickRunning: false, launchSessions: 2 }) };
  const poller = { stats: () => ({ active: 1, queued: 4, lastPollOkAt: now / 1000 - 5 }) };
  const health = createHealth({ db, cfg, poller, worker, roles: new Set(['bot', 'worker']), nowMs: () => now });
  const r = health.readiness();
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === 'worker-tick').ok, false);
  assert.equal(r.checks.find((c) => c.name === 'telegram-poll').ok, true);
  const m = health.metrics();
  assert.match(m, /mintpilot_updates_queued 4/);
  assert.match(m, /mintpilot_launch_sessions 2/);
  assert.doesNotMatch(m, /0x[0-9a-f]{40}/i);
  health.stop();
});

test('release gate: .env files, databases, keys and committed bot tokens are refused', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const root = path.resolve(__dirname, '..', '..');
  const probe = path.join(root, 'test', 'unit', '.release-probe.tmp');
  fs.writeFileSync(probe, `TELEGRAM_BOT_TOKEN=${'1234567890'}:AA${'x'.repeat(33)}\n`);
  try {
    const problems = audit(['.env', '.env.production', 'data/bot.sqlite', 'data/bot.sqlite-wal', 'keys/id.pem', 'node_modules/x/index.js', 'test/unit/.release-probe.tmp', '.env.example', 'src/index.js']);
    assert.ok(problems.some((p) => p.startsWith('.env: environment file')));
    assert.ok(problems.some((p) => p.startsWith('.env.production')));
    assert.ok(problems.some((p) => p.startsWith('data/bot.sqlite-wal')));
    assert.ok(problems.some((p) => p.startsWith('keys/id.pem')));
    assert.ok(problems.some((p) => p.includes('release-probe') && /Telegram bot token/.test(p)));
    assert.ok(!problems.some((p) => p.startsWith('.env.example') || p.startsWith('src/index.js')));
  } finally { fs.rmSync(probe, { force: true }); }
});

test('gas caps: GAS_CAP_JSON overrides the global cap per chain (Orbit/Arbitrum estimates include parent-chain data)', () => {
  const cfg = makeCfg();
  cfg.gas = { ...cfg.gas, byChain: { arbitrum: { base: 900000 } } };
  assert.equal(gasCap(cfg, 1, 'base'), 300000n);
  assert.equal(gasCap(cfg, 3, 'arbitrum'), 900000n + 2n * 100000n);
  assert.equal(gasLimitFor(cfg, 600000n, 1, 'base').ok, false);
  assert.equal(gasLimitFor(cfg, 600000n, 1, 'arbitrum').ok, true);
});
