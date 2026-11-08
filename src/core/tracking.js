'use strict';
const { tx } = require('../db');
const { limitsFor } = require('./plans');

const { UserError } = require('../util/format');
class TrackError extends UserError {}
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Add a tx to the tracker. `system` bypasses the plan limit (mint txs the bot itself asked the user to sign). */
function addTrackedTx(db, cfg, { telegramId, chain, txHash, scheduleId = null, system = false }, now) {
  if (!HASH_RE.test(txHash)) throw new TrackError('Transaction hash must be 0x + 64 hex characters.');
  return tx(db, () => {
    const hash = txHash.toLowerCase();
    const dup = db.prepare('SELECT id FROM tracked_txs WHERE telegram_id=? AND chain=? AND tx_hash=?').get(String(telegramId), chain, hash);
    if (dup) return { id: dup.id, duplicate: true };
    if (!system) {
      const { plan, pendingTxs } = limitsFor(cfg, db, telegramId, now);
      const n = db.prepare("SELECT COUNT(*) AS n FROM tracked_txs WHERE telegram_id=? AND status='pending'").get(String(telegramId)).n;
      if (n >= pendingTxs) throw new TrackError(`Your ${plan} plan can track ${pendingTxs} pending transactions at once.`);
    }
    const r = db.prepare('INSERT INTO tracked_txs (telegram_id, chain, tx_hash, schedule_id, created_at) VALUES (?,?,?,?,?)')
      .run(String(telegramId), chain, hash, scheduleId, now);
    return { id: Number(r.lastInsertRowid), duplicate: false };
  });
}

const pendingTxs = (db, limit = 100) => db.prepare("SELECT * FROM tracked_txs WHERE status='pending' ORDER BY created_at LIMIT ?").all(limit);

/**
 * Settle a pending tracked transaction. Atomic claim: returns true only for the caller that moved it
 * out of 'pending', so the tick and a launch session (or two workers) never both act on one receipt.
 */
function finishTx(db, id, { status, blockNumber = null, tokenIds = null }) {
  return db.prepare("UPDATE tracked_txs SET status=?, block_number=?, token_ids=? WHERE id=? AND status='pending'")
    .run(status, blockNumber, tokenIds ? JSON.stringify(tokenIds) : null, id).changes > 0;
}

const trackedByHash = (db, chain, hash) => db.prepare('SELECT * FROM tracked_txs WHERE chain=? AND tx_hash=? ORDER BY id DESC LIMIT 1').get(chain, String(hash).toLowerCase());

module.exports = { addTrackedTx, pendingTxs, finishTx, trackedByHash, TrackError, HASH_RE };
