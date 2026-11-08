'use strict';
const { tx } = require('../db');
const { limitsFor } = require('./plans');
const { byId, totalWei } = require('./presets');
const { parseEth, UserError } = require('../util/format');
const { normalizeAddress } = require('./wallets');
const { buildFromSpec, assertSpecKeys } = require('./mintAdapters');
const { automationBlocker, hasSigningKey } = require('./automationPolicy');
const { MAX_HORIZON_SEC } = require('../util/format');

class ScheduleError extends UserError {}

const ACTIVE = "('scheduled','ready')";

function createSchedule(db, cfg, chains, input, now) {
  return tx(db, () => {
    const chain = chains[input.chain];
    if (!chain) throw new ScheduleError('Unsupported network.');
    const contract = normalizeAddress(input.contract);
    const mintSpec = input.mintSpec || input.mint_spec || null;
    const triggerMode = input.triggerMode || input.trigger_mode || 'manual';
    if (!['manual', 'launch'].includes(triggerMode)) throw new ScheduleError('Unsupported mint trigger mode.');
    const preset = mintSpec ? null : byId(input.preset);
    if (!preset && !mintSpec) throw new ScheduleError('Unsupported mint method.');
    let quantity;
    let priceWei;
    let total;
    if (mintSpec) {
      let adapted;
      try {
        assertSpecKeys(mintSpec, 'stored');
        adapted = buildFromSpec(mintSpec, { contract, wallet_address: String(input.wallet).toLowerCase(), quantity: input.quantity, price_wei: input.priceWei || '0' });
      } catch (e) {
        throw new ScheduleError(e.message);
      }
      quantity = adapted.quantity;
      priceWei = typeof input.priceWei === 'bigint' ? input.priceWei : parseEth(input.priceWei || '0');
      total = adapted.valueWei;
    } else {
      quantity = preset.usesQuantity ? Number(input.quantity) : 1;
      priceWei = typeof input.priceWei === 'bigint' ? input.priceWei : parseEth(input.priceWei);
      total = totalWei(preset.id, priceWei, quantity);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > cfg.maxMintQuantity) {
      throw new ScheduleError(`Quantity must be between 1 and ${cfg.maxMintQuantity}.`);
    }
    if (total > parseEth(cfg.maxMintValueEth)) {
      throw new ScheduleError(`Total mint cost exceeds the safety cap of ${cfg.maxMintValueEth} ETH.`);
    }
    // Launch schedules are gated by the chain timestamp in the worker. Their
    // local wake-up timestamp may be now; requiring now+1 caused the confirm
    // callback to race the second clock tick and reject valid launch schedules.
    if (triggerMode !== 'launch' && (!Number.isInteger(input.scheduledAt) || input.scheduledAt < now + 30)) throw new ScheduleError('Schedule time must be in the future.');
    // Launch mode needs the opening time: before it, reverts are expected and retried; after
    // LAUNCH_GRACE_SECONDS an unexplained revert is final. Without it a pre-open revert would be fatal.
    const launchAt = input.launchAt == null ? null : Number(input.launchAt);
    const endAt = input.endAt == null ? null : Number(input.endAt);
    if (triggerMode === 'launch') {
      if (!Number.isInteger(launchAt) || launchAt <= 0) throw new ScheduleError('Launch mode needs the mint opening time.');
      if (launchAt > now + MAX_HORIZON_SEC) throw new ScheduleError('The opening time must be within the next 180 days.');
    }
    if (endAt != null && (!Number.isInteger(endAt) || endAt <= now)) throw new ScheduleError('That mint window has already ended.');
    if (endAt != null && launchAt != null && endAt <= launchAt) throw new ScheduleError('The mint window must end after it opens.');
    // Launch mode is gated by the on-chain opening, not by the timestamp
    // captured when the Telegram wizard displayed the confirmation. If the
    // user confirms after that timestamp, wake the worker immediately instead
    // of rejecting an otherwise valid launch schedule.
    const scheduledAt = triggerMode === 'launch'
      ? Math.max(Number.isInteger(input.scheduledAt) ? input.scheduledAt : now, now)
      : input.scheduledAt;

    const wallet = db.prepare('SELECT * FROM wallets WHERE telegram_id=? AND address=?').get(String(input.telegramId), String(input.wallet).toLowerCase());
    if (!wallet) throw new ScheduleError('That wallet is not one of your MintPilot wallets.');
    if (!hasSigningKey(wallet)) throw new ScheduleError('That wallet has no signing key on MintPilot, so it cannot be auto-signed. Use your platform wallet or import the wallet with /wallet.');
    const blocked = automationBlocker(cfg, chains, chain.key, total);
    if (blocked) throw new ScheduleError(blocked);

    const { plan, activeSchedules } = limitsFor(cfg, db, input.telegramId, now);
    const active = db.prepare(`SELECT COUNT(*) AS n FROM schedules WHERE telegram_id=? AND status IN ${ACTIVE}`).get(String(input.telegramId)).n;
    if (active >= activeSchedules) throw new ScheduleError(`Your ${plan} plan allows ${activeSchedules} active schedules. Cancel one or upgrade with /premium.`);

    const persistedSpec = mintSpec ? (typeof mintSpec === 'string' ? JSON.parse(mintSpec) : mintSpec) : null;
    const r = db.prepare(`INSERT INTO schedules
      (telegram_id, chain, contract, preset, quantity, price_wei, total_wei, wallet_address, scheduled_at, created_at, mint_spec, trigger_mode, launch_at, end_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(String(input.telegramId), chain.key, contract, persistedSpec ? `adapter:${persistedSpec.adapter}` : preset.id, quantity,
      priceWei.toString(), total.toString(), wallet.address, scheduledAt, now, persistedSpec ? JSON.stringify(persistedSpec) : null, triggerMode,
      launchAt, endAt);
    return Number(r.lastInsertRowid);
  });
}

function createSchedules(db, cfg, chains, inputs, now) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new ScheduleError('Select at least one wallet.');
  return tx(db, () => inputs.map((input) => createSchedule(db, cfg, chains, input, now)));
}

const getSchedule = (db, id) => db.prepare('SELECT * FROM schedules WHERE id=?').get(id);
const listSchedules = (db, telegramId, limit = 15) =>
  db.prepare('SELECT * FROM schedules WHERE telegram_id=? ORDER BY scheduled_at DESC LIMIT ?').all(String(telegramId), limit);

/**
 * Only the owner can cancel, and only before a transaction has been broadcast for it. A mint that is
 * pre-signed and waiting for its fire time ('armed') can still be cancelled: its signed bytes were never
 * sent, and the executor's fire step only broadcasts while the schedule is active (one atomic UPDATE).
 */
function cancelSchedule(db, id, telegramId) {
  return tx(db, () => {
    const cancelled = db.prepare(`UPDATE schedules SET status='cancelled' WHERE id=? AND telegram_id=? AND status IN ${ACTIVE}
      AND NOT EXISTS (SELECT 1 FROM execution_attempts a WHERE a.schedule_id=schedules.id AND a.status IN ('submitting','uncertain','submitted'))`).run(id, String(telegramId)).changes > 0;
    if (cancelled) {
      db.prepare(`UPDATE execution_attempts SET status='failed', error='cancelled before it was sent',
        updated_at=CAST(strftime('%s','now') AS INTEGER), resolved_at=CAST(strftime('%s','now') AS INTEGER) WHERE schedule_id=? AND status='armed'`).run(id);
    }
    return cancelled;
  });
}

function markSubmitted(db, id, txHash) {
  return db.prepare(`UPDATE schedules SET status='submitted', tx_hash=? WHERE id=? AND status IN ${ACTIVE}`).run(txHash, id).changes > 0;
}

/** Check completion; the worker acquires its durable wallet lease before this check. */
function claimReminder(db, scheduleId, kind, now) {
  return !db.prepare('SELECT 1 FROM reminders_sent WHERE schedule_id=? AND kind=?').get(scheduleId, kind);
}
/** Persist completion only after the side effect succeeds; retries remain possible after crashes. */
function completeReminder(db, scheduleId, kind, now) {
  return db.prepare('INSERT OR IGNORE INTO reminders_sent (schedule_id, kind, sent_at) VALUES (?,?,?)').run(scheduleId, kind, now).changes > 0;
}
// Kept as a no-op-compatible helper for retry branches; in-progress claims are not persisted.
const releaseReminder = () => ({ changes: 0 });

/**
 * Schedules the worker should look at: manual-time schedules from 10 minutes before (pre-mint alerts),
 * launch schedules from `armSec` before their opening (the launch engine arms them), and only once any
 * back-off has elapsed.
 */
function reminderCandidates(db, now, armSec = 60) {
  return db.prepare(`SELECT s.*, u.premium_until, u.blocked_bot FROM schedules s JOIN users u ON u.telegram_id = s.telegram_id
    WHERE s.status IN ${ACTIVE} AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= ?)
      AND ((s.trigger_mode='launch' AND (s.launch_at IS NULL OR s.launch_at <= ? + ?))
        OR (s.trigger_mode<>'launch' AND s.scheduled_at - MAX(600, ?) <= ?))`).all(now, now, armSec, armSec, now);
}

/** When a schedule stops trying: its mint window end, else its start/opening time + maxWaitSec. */
function scheduleDeadline(s, maxWaitSec) {
  if (s.end_at != null) return Number(s.end_at);
  const start = s.trigger_mode === 'launch' ? (s.launch_at ?? s.scheduled_at) : s.scheduled_at;
  return Number(start) + Number(maxWaitSec);
}

/** Expire active schedules past their deadline. Returns the expired rows so the caller can notify. */
function expireStale(db, now, maxWaitSec = 21600) {
  return tx(db, () => {
    const rows = db.prepare(`SELECT * FROM schedules WHERE status IN ${ACTIVE}
      AND COALESCE(end_at, CASE WHEN trigger_mode='launch' THEN COALESCE(launch_at, scheduled_at) ELSE scheduled_at END + ?) < ?`).all(maxWaitSec, now);
    // An open execution attempt means a transaction may exist; leave those to reconciliation.
    const open = db.prepare("SELECT 1 FROM execution_attempts WHERE schedule_id=? AND status IN ('submitting','uncertain','submitted')");
    const expired = rows.filter((r) => !open.get(r.id));
    const update = db.prepare(`UPDATE schedules SET status='expired' WHERE id=? AND status IN ${ACTIVE}`);
    // A pre-signed mint that never fired before the deadline must never fire afterwards.
    const disarm = db.prepare("UPDATE execution_attempts SET status='failed', error='schedule expired before it was sent', updated_at=?, resolved_at=? WHERE schedule_id=? AND status='armed'");
    return expired.filter((r) => {
      if (update.run(r.id).changes === 0) return false;
      disarm.run(now, now, r.id);
      return true;
    });
  });
}

/**
 * Keep an active schedule and try again at `nextAttemptAt`.
 * `attempts` counts consecutive back-off-eligible deferrals: 'increment' (RETRY, OpenSea waits),
 * 'reset' (chain-side WAIT: poll every tick near a launch), or 'keep'.
 */
function deferSchedule(db, id, { nextAttemptAt, lastError = null, attempts = 'increment' }) {
  const expr = attempts === 'reset' ? '0' : attempts === 'keep' ? 'attempts' : 'attempts+1';
  return db.prepare(`UPDATE schedules SET next_attempt_at=?, attempts=${expr}, last_error=? WHERE id=? AND status IN ${ACTIVE}`).run(nextAttemptAt, lastError, id).changes > 0;
}

/** Stop an active schedule for good. */
function failSchedule(db, id, lastError) {
  return db.prepare(`UPDATE schedules SET status='failed', last_error=? WHERE id=? AND status IN ${ACTIVE}`).run(lastError, id).changes > 0;
}

/**
 * A submitted mint reverted on-chain: put the schedule back in play so a fresh transaction (new nonce)
 * is signed, as long as the window is open and the re-sign budget lasts. Atomic; returns the new
 * chain_retries count, or null when the schedule must be failed instead.
 */
function requeueAfterRevert(db, id, { now, maxRetries, deadline }) {
  return tx(db, () => {
    const s = db.prepare('SELECT status, chain_retries FROM schedules WHERE id=?').get(id);
    if (!s || s.status !== 'submitted' || Number(s.chain_retries) >= Number(maxRetries) || (deadline != null && now > deadline)) return null;
    db.prepare(`UPDATE schedules SET status='scheduled', tx_hash=NULL, chain_retries=chain_retries+1, next_attempt_at=NULL, attempts=0,
      last_error='mint reverted on-chain; re-signing' WHERE id=? AND status='submitted'`).run(id);
    // The 'due' marker means "nothing left to do"; the schedule has work again.
    db.prepare("DELETE FROM reminders_sent WHERE schedule_id=? AND kind='due'").run(id);
    return Number(s.chain_retries) + 1;
  });
}

module.exports = { createSchedule, createSchedules, getSchedule, listSchedules, cancelSchedule, markSubmitted, claimReminder, completeReminder, releaseReminder, reminderCandidates, expireStale, scheduleDeadline, deferSchedule, failSchedule, requeueAfterRevert, ScheduleError };
