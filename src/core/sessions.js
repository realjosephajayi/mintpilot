'use strict';
const crypto = require('node:crypto');

function createSession(db, { kind, telegramId, refId = null, challenge = null, ttlSec }, now) {
  const id = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO web_sessions (id, kind, telegram_id, ref_id, challenge, expires_at, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, kind, String(telegramId), refId, challenge, now + ttlSec, now);
  return id;
}

/** Returns the session if it exists, matches kind, hasn't expired and hasn't been consumed. */
function getValidSession(db, id, kind, now) {
  if (typeof id !== 'string' || id.length < 20 || id.length > 64) return null;
  const s = db.prepare('SELECT * FROM web_sessions WHERE id=? AND kind=?').get(id, kind);
  if (!s || s.used_at || s.expires_at <= now) return null;
  return s;
}

/** Atomically mark a session used. Returns true only for the first caller (replay-safe). */
function consumeSession(db, id, now) {
  return db.prepare('UPDATE web_sessions SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at > ?').run(now, id, now).changes > 0;
}

function buildLinkChallenge({ domain, telegramId, nonce, issuedAt, expiresAt }) {
  return [
    'MintPilot Wallet Authorization',
    '',
    `Website: https://${domain}`,
    'Purpose: Link your owner wallet to MintPilot',
    '',
    'By signing, you confirm that you control this wallet.',
    'This signature is free and does not send a transaction, move funds, or grant token approvals.',
    'MintPilot will never ask for your seed phrase or private key.',
    '',
    `Telegram account: ${telegramId}`,
    '',
    'Security details',
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt * 1000).toISOString()}`,
    `Expires: ${new Date(expiresAt * 1000).toISOString()}`
  ].join('\n');
}

/** Create a wallet-link session with its exact challenge text. */
function createLinkSession(db, { telegramId, domain, ttlSec = 600 }, now) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const challenge = buildLinkChallenge({ domain, telegramId, nonce, issuedAt: now, expiresAt: now + ttlSec });
  return createSession(db, { kind: 'link', telegramId, challenge, ttlSec }, now);
}

module.exports = { createSession, getValidSession, consumeSession, buildLinkChallenge, createLinkSession };
