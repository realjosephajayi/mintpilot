'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Wallet } = require('ethers');
const { T0, A, makeCfg, makeDb, addUser, addWallet, getChains, silent } = require('./helpers');
const { createWebServer, clientIp } = require('../../src/web/server');
const { createLinkSession } = require('../../src/core/sessions');
const { createSchedule } = require('../../src/core/schedules');
const { createDashboardSession } = require('../../src/core/dashboard');
const { getCustodialPrivateKey } = require('../../src/core/custodialWallets');

async function boot(cfgOver = {}) {
  const cfg = makeCfg(cfgOver); const db = makeDb(); const chains = getChains(cfg);
  const notes = []; let t = T0;
  const server = createWebServer({
    db, cfg, log: silent, now: () => t,
    verifySignature: async ({ signature, address }) => (signature === `sig:${address}` ? { ok: true, type: 'eoa' } : { ok: false }),
    notify: async (id, text) => { notes.push({ id: String(id), text }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { cfg, db, chains, notes, base, post, server, setNow: (x) => { t = x; }, close: () => new Promise((r) => server.close(r)) };
}
const key = () => { const w = Wallet.createRandom(); return { address: w.address.toLowerCase(), privateKey: w.privateKey }; };

test('serves the import and dashboard pages with strict security headers; health check', async () => {
  const w = await boot();
  const res = await fetch(w.base + '/import');
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'(;|$)/, 'pages only talk to this server');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(w.base + '/healthz')).status, 200);
  assert.equal((await fetch(w.base + '/assets/wallet-import.js')).status, 200);
  assert.equal((await fetch(w.base + '/nope')).status, 404);
  await w.close();
});

test('manual-signing and legacy smart-account routes no longer exist', async () => {
  const w = await boot();
  for (const p of ['/mint', '/connect', '/authorize', '/assets/wallet.js', '/assets/wallet-appkit.js', '/api/mint/prepare?s=x', '/api/appkit/config', '/api/policy/prepare?s=x']) {
    assert.equal((await fetch(w.base + p)).status, 404, p);
  }
  assert.equal((await w.post('/api/mint/submitted', { s: 'x', txHash: '0x' + 'ab'.repeat(32) })).status, 404);
  assert.equal((await w.post('/api/policy/activate', { s: 'x' })).status, 404);
  await w.close();
});

test('dashboard is private, read-only, scoped to the session owner and shows the last status', async () => {
  const w = await boot(); addUser(w.db, 1); addWallet(w.db, w.cfg, 1, A(1));
  const id = createSchedule(w.db, w.cfg, w.chains, { telegramId: 1, chain: 'base', contract: A(5), preset: 'mint(uint256)', quantity: 1, priceWei: '0.01', scheduledAt: T0 + 3600, wallet: A(1) }, T0);
  w.db.prepare("UPDATE schedules SET last_error='Mint not open yet.' WHERE id=?").run(id);
  const sid = createDashboardSession(w.db, { telegramId: 1, now: T0 });
  assert.equal((await fetch(`${w.base}/dashboard?s=${sid}`)).status, 200);
  const result = await (await fetch(`${w.base}/api/dashboard?s=${sid}`)).json();
  assert.equal(result.wallets.length, 1);
  assert.equal(result.wallets[0].has_custodial_key, 1);
  assert.equal(Object.hasOwn(result.wallets[0], 'ciphertext'), false);
  assert.equal(result.schedules[0].last_error, 'Mint not open yet.');
  assert.equal((await fetch(`${w.base}/api/dashboard?s=${'x'.repeat(40)}`)).status, 400);
  await w.close();
});

test('wallet import: stores an encrypted key that decrypts to the wallet, notifies, and cannot be replayed', async () => {
  const w = await boot(); addUser(w.db, 1, { premium: true });
  const k = key();
  const sid = createLinkSession(w.db, { telegramId: 1, domain: 'bot.example' }, T0);
  const ch = await (await fetch(`${w.base}/api/link/challenge?s=${sid}`)).json();
  assert.match(ch.message, /Telegram account: 1/);
  const ok = await w.post('/api/link/verify', { s: sid, address: k.address, signature: `sig:${k.address}`, privateKey: k.privateKey });
  assert.equal(ok.status, 200);
  const row = w.db.prepare('SELECT * FROM wallets WHERE address=?').get(k.address);
  assert.equal(row.telegram_id, '1');
  assert.equal(getCustodialPrivateKey(row, w.cfg).privateKey, k.privateKey);
  assert.ok(w.notes.some((n) => n.id === '1' && /sign scheduled mints/.test(n.text)));
  const k2 = key();
  const replay = await w.post('/api/link/verify', { s: sid, address: k2.address, signature: `sig:${k2.address}`, privateKey: k2.privateKey });
  assert.equal(replay.status, 400);
  await w.close();
});

test('signature-only linking is refused: MintPilot cannot use a wallet it cannot sign for', async () => {
  const w = await boot(); addUser(w.db, 1, { premium: true });
  const sid = createLinkSession(w.db, { telegramId: 1, domain: 'bot.example' }, T0);
  const res = await w.post('/api/link/verify', { s: sid, address: A(1), signature: `sig:${A(1)}` });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /signing key is required/);
  const k = key();
  const mismatched = await w.post('/api/link/verify', { s: sid, address: A(1), signature: `sig:${A(1)}`, privateKey: k.privateKey });
  assert.match((await mismatched.json()).error, /does not match/);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM wallets').get().n, 0);
  await w.close();
});

test('wallet import: bad signature does not burn the session; expired sessions rejected; duplicates refused', async () => {
  const w = await boot(); addUser(w.db, 1, { premium: true }); addUser(w.db, 2, { premium: true });
  const k = key();
  const sid = createLinkSession(w.db, { telegramId: 1, domain: 'bot.example', ttlSec: 60 }, T0);
  assert.equal((await w.post('/api/link/verify', { s: sid, address: k.address, signature: 'sig:somebody-else', privateKey: k.privateKey })).status, 400);
  assert.equal((await w.post('/api/link/verify', { s: sid, address: k.address, signature: `sig:${k.address}`, privateKey: k.privateKey })).status, 200);
  const other = createLinkSession(w.db, { telegramId: 2, domain: 'bot.example' }, T0);
  assert.equal((await w.post('/api/link/verify', { s: other, address: k.address, signature: `sig:${k.address}`, privateKey: k.privateKey })).status, 409);
  const sid2 = createLinkSession(w.db, { telegramId: 1, domain: 'bot.example', ttlSec: 60 }, T0);
  w.setNow(T0 + 61);
  assert.equal((await w.post('/api/link/verify', { s: sid2, address: k.address, signature: `sig:${k.address}`, privateKey: k.privateKey })).status, 400);
  await w.close();
});

test('rejects oversized and malformed bodies; rate limits per IP', async () => {
  const w = await boot();
  assert.equal((await fetch(w.base + '/api/link/verify', { method: 'POST', body: 'x'.repeat(20000) })).status, 413);
  assert.equal((await fetch(w.base + '/api/link/verify', { method: 'POST', body: '{nope' })).status, 400);
  let limited = false;
  for (let i = 0; i < 70; i++) if ((await fetch(w.base + '/import')).status === 429) { limited = true; break; }
  assert.ok(limited);
  // Liveness/readiness probes are never rate limited (platform health checks poll them constantly).
  assert.equal((await fetch(w.base + '/healthz')).status, 200);
  await w.close();
});

test('behind a proxy, a client-supplied X-Forwarded-For cannot dodge the rate limit (review #14)', async () => {
  const w = await boot({ trustProxyHops: 1 });
  const get = (spoof) => new Promise((resolve, reject) => {
    // The proxy appends the real client (127.0.0.1 here); the client put a spoofed value first.
    const req = http.get(w.base + '/import', { headers: { 'x-forwarded-for': `${spoof}, 127.0.0.1` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  let limited = false;
  for (let i = 0; i < 70; i++) if ((await get(`10.0.0.${i}`)) === 429) { limited = true; break; }
  assert.ok(limited, 'rotating the spoofed first entry must not reset the limit');
  await w.close();
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }, socket: { remoteAddress: '9.9.9.9' } }, 2), '2.2.2.2');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }, 1), '9.9.9.9');
  // Behind a Cloudflare tunnel every request arrives from loopback: the edge's header separates users.
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' } }, 0, 'cf-connecting-ip'), '203.0.113.7');
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': 'not an ip<script>' }, socket: { remoteAddress: '127.0.0.1' } }, 0, 'cf-connecting-ip'), '127.0.0.1');
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' } }, 0, ''), '127.0.0.1', 'header ignored unless configured');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1' }, socket: { remoteAddress: '9.9.9.9' } }, 0), '9.9.9.9');
});

test('readiness and metrics: /readyz reports checks; /metrics needs METRICS_TOKEN as a bearer token', async () => {
  const health = { readiness: () => ({ ok: false, checks: [{ name: 'worker-tick', ok: false }] }), metrics: () => 'mintpilot_up 1\n' };
  const cfg = makeCfg({ metricsToken: 's3cret-token' }); const db = makeDb();
  const server = createWebServer({ db, cfg, log: silent, health, verifySignature: async () => ({ ok: false }), notify: async () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ready = await fetch(base + '/readyz');
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).checks[0].name, 'worker-tick');
    assert.equal((await fetch(base + '/metrics')).status, 401);
    assert.equal((await fetch(base + '/metrics', { headers: { authorization: 'Bearer wrong-token!' } })).status, 401);
    const ok = await fetch(base + '/metrics', { headers: { authorization: 'Bearer s3cret-token' } });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /mintpilot_up 1/);
  } finally { await new Promise((r) => server.close(r)); }
  // Without a token the endpoint does not exist.
  const closed = createWebServer({ db, cfg: makeCfg(), log: silent, health, verifySignature: async () => ({ ok: false }), notify: async () => {} });
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  try { assert.equal((await fetch(`http://127.0.0.1:${closed.address().port}/metrics`)).status, 404); }
  finally { await new Promise((r) => closed.close(r)); }
});
