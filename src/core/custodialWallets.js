'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { Wallet, getAddress } = require('ethers');
const { tx } = require('../db');

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_OPTIONS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
const scryptAsync = promisify(crypto.scrypt);

// Derived AES keys, per (master key, wallet salt). scrypt costs ~40 ms of CPU; without the cache every
// decrypt paid it, and the synchronous form blocked the whole bot while a launch armed many wallets.
// The cache holds per-wallet keys derived from the master key, which is itself held in process memory,
// so it adds no new secret class. Bounded; oldest entries are evicted first.
const KEY_CACHE_MAX = 5000;
const keyCache = new Map();

function masterKey(value) {
  if (!value || typeof value !== 'string') throw new Error('AUTOMATION_MASTER_KEY is required to create a platform wallet.');
  const raw = Buffer.from(value.replace(/^0x/, ''), 'hex');
  if (raw.length !== KEY_BYTES) throw new Error('AUTOMATION_MASTER_KEY must be exactly 32 bytes of hex.');
  return raw;
}

const cacheKey = (secret, salt) => `${crypto.createHash('sha256').update(secret).digest('base64url').slice(0, 16)}:${salt.toString('base64url')}`;
function remember(key, derived) {
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value);
  keyCache.set(key, derived);
  return derived;
}

/** Synchronous derivation (cached). Kept for small, rare paths and tests; hot paths use deriveKeyAsync. */
function deriveKey(secret, salt) {
  const key = cacheKey(secret, salt);
  return keyCache.get(key) || remember(key, crypto.scryptSync(secret, salt, KEY_BYTES, SCRYPT_OPTIONS));
}

/** Derivation on the libuv thread pool: never blocks the event loop (cached). */
async function deriveKeyAsync(secret, salt) {
  const key = cacheKey(secret, salt);
  const hit = keyCache.get(key);
  if (hit) return hit;
  return remember(key, await scryptAsync(secret, salt, KEY_BYTES, SCRYPT_OPTIONS));
}

function encrypt(privateKey, derived, salt) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, derived, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), 'hex')), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64url'), iv: iv.toString('base64url'), authTag: cipher.getAuthTag().toString('base64url'), salt: salt.toString('base64url') };
}

function decrypt(row, derived) {
  const decipher = crypto.createDecipheriv(ALGORITHM, derived, Buffer.from(row.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64url'));
  return '0x' + Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64url')), decipher.final()]).toString('hex');
}

const DECRYPT_FAILED = 'The platform wallet could not be decrypted. Stop automation and rotate the wallet if the master key changed.';

function seal(privateKey, secret) {
  const salt = crypto.randomBytes(SALT_BYTES);
  return encrypt(privateKey, deriveKey(masterKey(secret), salt), salt);
}

async function sealAsync(privateKey, secret) {
  const salt = crypto.randomBytes(SALT_BYTES);
  return encrypt(privateKey, await deriveKeyAsync(masterKey(secret), salt), salt);
}

function open(row, secret) {
  try { return decrypt(row, deriveKey(masterKey(secret), Buffer.from(row.salt, 'base64url'))); }
  catch { throw new Error(DECRYPT_FAILED); }
}

async function openAsync(row, secret) {
  let derived;
  try { derived = await deriveKeyAsync(masterKey(secret), Buffer.from(row.salt, 'base64url')); } catch { throw new Error(DECRYPT_FAILED); }
  try { return decrypt(row, derived); } catch { throw new Error(DECRYPT_FAILED); }
}

const platformRow = (db, telegramId) => db.prepare("SELECT * FROM wallets WHERE telegram_id=? AND wallet_type='platform'").get(String(telegramId));

function insertPlatformWallet(db, telegramId, address, encrypted, now) {
  return tx(db, () => {
    const again = platformRow(db, telegramId);
    if (again) return again;
    const result = db.prepare(`INSERT INTO wallets
      (telegram_id, address, sig_type, verified_at, wallet_type, ciphertext, iv, auth_tag, salt)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(String(telegramId), address.toLowerCase(), 'custodial', Number(now), 'platform', encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.salt);
    return db.prepare('SELECT * FROM wallets WHERE id=?').get(Number(result.lastInsertRowid));
  });
}

function ensurePlatformWallet(db, cfg, telegramId, now) {
  const existing = platformRow(db, telegramId);
  if (existing) return existing;
  const wallet = Wallet.createRandom();
  return insertPlatformWallet(db, telegramId, wallet.address, seal(wallet.privateKey, cfg.automation.encryptionKey), now);
}

// One provisioning per user at a time, so a burst of updates from a new user creates one wallet.
const provisioning = new Map();
/** Non-blocking platform-wallet provisioning (key sealing on the thread pool). */
async function ensurePlatformWalletAsync(db, cfg, telegramId, now) {
  const existing = platformRow(db, telegramId);
  if (existing) return existing;
  const id = String(telegramId);
  if (provisioning.has(id)) return provisioning.get(id);
  const p = (async () => {
    const wallet = Wallet.createRandom();
    const encrypted = await sealAsync(wallet.privateKey, cfg.automation.encryptionKey);
    return insertPlatformWallet(db, telegramId, wallet.address, encrypted, now);
  })().finally(() => provisioning.delete(id));
  provisioning.set(id, p);
  return p;
}

function getPlatformPrivateKey(db, cfg, telegramId) {
  const row = platformRow(db, telegramId);
  if (!row) throw new Error('No platform wallet exists for this user.');
  return getCustodialPrivateKey(row, cfg);
}

function assertSealed(row) {
  if (!row || !row.ciphertext || !row.iv || !row.auth_tag || !row.salt) throw new Error('This wallet has no encrypted signing key. Re-import it to enable automatic signing.');
}

function getCustodialPrivateKey(row, cfg) {
  assertSealed(row);
  return { id: row.id, address: getAddress(row.address), privateKey: open(row, cfg.automation.encryptionKey) };
}

async function getCustodialPrivateKeyAsync(row, cfg) {
  assertSealed(row);
  return { id: row.id, address: getAddress(row.address), privateKey: await openAsync(row, cfg.automation.encryptionKey) };
}

module.exports = {
  ensurePlatformWallet, ensurePlatformWalletAsync, getPlatformPrivateKey,
  getCustodialPrivateKey, getCustodialPrivateKeyAsync, seal, sealAsync
};
