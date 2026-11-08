'use strict';
const { randomUUID } = require('node:crypto');

/**
 * Cross-process lease locks for workers that share the same SQLite database file.
 * Every operation is a single short atomic statement; no lock is held as a SQL
 * transaction across RPC, signing, or Telegram awaits.
 */
function createWalletExecutionLocks({ db, ttlSec = 120, now = () => Math.floor(Date.now() / 1000), tokenFactory = randomUUID } = {}) {
  if (!db) throw new Error('A database is required for wallet execution locks.');
  if (!Number.isInteger(ttlSec) || ttlSec < 30 || ttlSec > 900) throw new Error('Wallet execution lock TTL must be between 30 and 900 seconds.');

  function timestamp() { return Math.floor(Number(now())); }

  function acquire(address) {
    const walletAddress = String(address || '').toLowerCase();
    if (!walletAddress) throw new Error('Wallet address is required for an execution lock.');
    const token = tokenFactory();
    const at = timestamp();
    const result = db.prepare(`INSERT INTO wallet_execution_locks (wallet_address, owner_token, lease_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET owner_token=excluded.owner_token,
        lease_until=excluded.lease_until, updated_at=excluded.updated_at
      WHERE wallet_execution_locks.lease_until <= ?`).run(walletAddress, token, at + ttlSec, at, at, at);
    if (result.changes !== 1) return null;
    return { walletAddress, token, leaseUntil: at + ttlSec };
  }

  function renew(lock) {
    if (!lock?.walletAddress || !lock?.token) return false;
    const at = timestamp();
    const result = db.prepare(`UPDATE wallet_execution_locks SET lease_until=?, updated_at=?
      WHERE wallet_address=? AND owner_token=? AND lease_until>?`).run(at + ttlSec, at, lock.walletAddress, lock.token, at);
    if (result.changes !== 1) return false;
    lock.leaseUntil = at + ttlSec;
    return true;
  }

  function owns(lock) {
    if (!lock?.walletAddress || !lock?.token) return false;
    const at = timestamp();
    return Boolean(db.prepare(`SELECT 1 AS owned FROM wallet_execution_locks
      WHERE wallet_address=? AND owner_token=? AND lease_until>?`).get(lock.walletAddress, lock.token, at));
  }

  function release(lock) {
    if (!lock?.walletAddress || !lock?.token) return false;
    return db.prepare('DELETE FROM wallet_execution_locks WHERE wallet_address=? AND owner_token=?').run(lock.walletAddress, lock.token).changes === 1;
  }

  return { acquire, renew, owns, release, ttlSec };
}

module.exports = { createWalletExecutionLocks };
