'use strict';
// Tiny HTTP server (node:http). MintPilot only signs automatically, so the web surface is:
//   /import     — Premium wallet portal: create or import an EVM key into encrypted custody
//   /dashboard  — private, expiring, read-only summary
// There is no browser signing page: users never sign mint transactions themselves.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('ethers');
const { getValidSession, consumeSession } = require('../core/sessions');
const { linkWallet, WalletError, normalizeAddress } = require('../core/wallets');
const { sealAsync } = require('../core/custodialWallets');
const { getDashboardSession } = require('../core/dashboard');
const { createLimiter } = require('../util/ratelimit');
const { shortAddr } = require('../util/format');
const { getChains } = require('../chains');

const PUBLIC_DIR = path.join(__dirname, 'public');
const FILES = {
  '/import': ['import.html', 'text/html; charset=utf-8'],
  '/dashboard': ['dashboard.html', 'text/html; charset=utf-8'],
  '/assets/wallet-import.js': ['assets/wallet-import.js', 'text/javascript; charset=utf-8'],
  '/assets/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
  '/assets/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/assets/mintpilot-logo.webp': ['assets/mintpilot-logo.webp', 'image/webp']
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Client IP for rate limiting.
 * - CLIENT_IP_HEADER (e.g. cf-connecting-ip behind a Cloudflare tunnel): a single-value header set by an
 *   edge we control. Only safe when the origin is reachable through that edge alone.
 * - Otherwise proxies append to X-Forwarded-For, so only the entry added by the last proxy we control
 *   is trustworthy; earlier entries are client-supplied. `trustProxyHops` = proxies in front of us.
 * Without either, every request behind a tunnel shares the tunnel's loopback address (one bucket).
 */
function clientIp(req, trustProxyHops, trustedHeader = '') {
  if (trustedHeader) {
    const value = String(req.headers[trustedHeader] || '').trim();
    if (value && value.length <= 64 && /^[0-9a-fA-F:.]+$/.test(value)) return value;
  }
  const hops = Number(trustProxyHops) || 0;
  if (hops > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length >= hops) return xff[xff.length - hops];
  }
  return req.socket.remoteAddress || 'unknown';
}

function createWebServer({ db, cfg, verifySignature, notify, health = null, now = () => Math.floor(Date.now() / 1000), log = console }) {
  const limiter = createLimiter({ limit: 60, windowSec: 60, now });
  const sweeper = setInterval(() => limiter.sweep(), 60_000);
  if (sweeper.unref) sweeper.unref();
  const metricsToken = cfg.metricsToken ? Buffer.from(cfg.metricsToken) : null;
  const bearerOk = (req) => {
    if (!metricsToken) return false;
    const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    return given.length === metricsToken.length && crypto.timingSafeEqual(given, metricsToken);
  };
  const cache = new Map();
  const readFile = (name) => { if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(PUBLIC_DIR, name))); return cache.get(name); };

  const baseHeaders = {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store'
  };
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { ...baseHeaders, 'content-type': type });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const fail = (res, status, error) => send(res, status, { error });

  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 8192) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
  }

  /** Create/import an EVM wallet into encrypted custody. A signing key is mandatory: MintPilot only auto-signs. */
  async function handleLinkVerify(res, body) {
    const t = now();
    const session = getValidSession(db, body.s, 'link', t);
    if (!session) return fail(res, 400, 'This link has expired or was already used. Request a new wallet link from the bot.');
    let address;
    try { address = normalizeAddress(body.address); } catch (e) { return fail(res, 400, e.message); }
    if (typeof body.signature !== 'string' || body.signature.length > 2000) return fail(res, 400, 'Bad signature.');
    if (typeof body.privateKey !== 'string' || !body.privateKey) return fail(res, 400, 'A signing key is required: MintPilot signs mints automatically and cannot use a signature-only wallet.');

    const check = await verifySignature({ message: session.challenge, signature: body.signature, address });
    if (!check.ok) return fail(res, 400, 'Signature does not match this wallet.');
    let encrypted;
    try {
      const wallet = new Wallet(body.privateKey);
      if (wallet.address.toLowerCase() !== address.toLowerCase()) return fail(res, 400, 'The signing key does not match the wallet address.');
      encrypted = await sealAsync(wallet.privateKey, cfg.automation.encryptionKey);
    } catch { return fail(res, 400, 'The wallet key could not be validated for encrypted custody.'); }

    try { linkWallet(db, cfg, session.telegram_id, address, 'custodial', t, encrypted); }
    catch (e) {
      if (e instanceof WalletError) return fail(res, 409, e.message);
      throw e;
    }
    // Consume only after the wallet has been accepted. A failed quota or duplicate
    // attempt must leave the single-use session available for a corrected retry.
    if (!consumeSession(db, session.id, t)) return fail(res, 400, 'This link was already used.'); // replay guard
    notify(session.telegram_id, `✅ Wallet <code>${shortAddr(address)}</code> added. MintPilot can now sign scheduled mints from it automatically.`).catch(() => {});
    return send(res, 200, { ok: true, address });
  }

  async function handleDashboard(res, sid) {
    const session = getDashboardSession(db, sid, now());
    if (!session) return fail(res, 400, 'This dashboard link has expired. Send /dashboard to the bot again.');
    const wallets = db.prepare('SELECT address, wallet_type, verified_at, CASE WHEN ciphertext IS NOT NULL THEN 1 ELSE 0 END AS has_custodial_key FROM wallets WHERE telegram_id=? ORDER BY id').all(session.telegram_id);
    const schedules = db.prepare(`SELECT id, chain, contract, preset, quantity, total_wei, wallet_address, scheduled_at, created_at, status, tx_hash, trigger_mode, launch_at, end_at, last_error, attempts
      FROM schedules WHERE telegram_id=? ORDER BY scheduled_at DESC LIMIT 100`).all(session.telegram_id);
    const tracked = db.prepare('SELECT schedule_id, chain, tx_hash, status, block_number, token_ids, created_at FROM tracked_txs WHERE telegram_id=? ORDER BY created_at DESC LIMIT 100').all(session.telegram_id);
    // Recent execution attempts: a record of what MintPilot tried and what happened. Error text is cleaned of URLs (RPC endpoints can carry keys).
    const activity = db.prepare(`SELECT a.schedule_id, a.chain, a.status, a.error, a.tx_hash, a.created_at
      FROM execution_attempts a JOIN schedules s ON s.id = a.schedule_id WHERE s.telegram_id=? ORDER BY a.created_at DESC, a.id DESC LIMIT 100`).all(session.telegram_id)
      .map((a) => ({ ...a, error: a.error ? String(a.error).replace(/https?:\/\/\S+/gi, '[link]').replace(/[\r\n\u0000-\u001f]+/g, ' ').slice(0, 160) : null }));
    // Explorer base URLs so the page can link each transaction.
    const explorers = {};
    let known = {};
    try { known = getChains(cfg); } catch { /* links are optional */ }
    for (const key of new Set([...schedules, ...tracked, ...activity].map((r) => r.chain))) {
      const explorer = known[key] && known[key].explorer;
      if (typeof explorer === 'string' && /^https?:\/\//.test(explorer)) explorers[key] = explorer.replace(/\/+$/, '');
    }
    return send(res, 200, { now: now(), expiresAt: session.expires_at, wallets, schedules, tracked, activity, explorers });
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/readyz') {
        if (!health) return send(res, 200, { ok: true, checks: [] });
        const r = health.readiness();
        return send(res, r.ok ? 200 : 503, r);
      }
      if (req.method === 'GET' && url.pathname === '/metrics') {
        if (!health || !metricsToken) return fail(res, 404, 'Not found');
        if (!bearerOk(req)) return fail(res, 401, 'Unauthorized');
        return send(res, 200, health.metrics(), 'text/plain; version=0.0.4; charset=utf-8');
      }
      if (!limiter.allow(clientIp(req, cfg.trustProxyHops, cfg.clientIpHeader))) return fail(res, 429, 'Too many requests.');

      if (req.method === 'GET' && FILES[url.pathname]) return send(res, 200, readFile(FILES[url.pathname][0]), FILES[url.pathname][1]);
      if (req.method === 'GET' && url.pathname === '/api/dashboard') return await handleDashboard(res, url.searchParams.get('s'));
      if (req.method === 'GET' && url.pathname === '/api/link/challenge') {
        const s = getValidSession(db, url.searchParams.get('s'), 'link', now());
        if (!s) return fail(res, 400, 'This link has expired or was already used. Request a new wallet link from the bot.');
        return send(res, 200, { message: s.challenge, expiresAt: s.expires_at });
      }
      if (req.method === 'POST' && url.pathname === '/api/link/verify') return await handleLinkVerify(res, await readJson(req));
      return fail(res, 404, 'Not found');
    } catch (e) {
      if (e.status) return fail(res, e.status, e.message);
      log.error('web error', e);
      return fail(res, 500, 'Internal error');
    }
  };

  const server = http.createServer(handler);
  // Bounded socket behaviour for many concurrent clients behind a proxy.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.on('close', () => clearInterval(sweeper));
  return server;
}

module.exports = { createWebServer, clientIp };
