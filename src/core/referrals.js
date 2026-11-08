'use strict';
const { tx } = require('../db');
const { extendPremium } = require('./users');

/**
 * Called only when a brand-new user starts the bot with ?start=ref_<code>.
 * Self-referrals and unknown codes are ignored. A user can only ever have one referrer.
 */
function registerReferral(db, refereeId, code, now) {
  const referrer = db.prepare('SELECT telegram_id FROM users WHERE ref_code=?').get(String(code));
  if (!referrer || referrer.telegram_id === String(refereeId)) return false;
  const r = db.prepare('INSERT OR IGNORE INTO referrals (referee_id, referrer_id, created_at) VALUES (?,?,?)').run(String(refereeId), referrer.telegram_id, now);
  if (r.changes) db.prepare('UPDATE users SET referred_by=? WHERE telegram_id=?').run(referrer.telegram_id, String(refereeId));
  return r.changes > 0;
}

/**
 * Pay out once the referee has linked a verified wallet (and, optionally, passed an activity check).
 * Returns { referrerId } when a reward was granted, otherwise null.
 */
function rewardReferral(db, cfg, refereeId, now) {
  return tx(db, () => {
    const ref = db.prepare("SELECT * FROM referrals WHERE referee_id=? AND status='pending'").get(String(refereeId));
    if (!ref) return null;
    const rewarded = db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE referrer_id=? AND status='rewarded'").get(ref.referrer_id).n;
    if (rewarded >= cfg.referral.maxRewards) return null;
    db.prepare("UPDATE referrals SET status='rewarded', rewarded_at=? WHERE referee_id=?").run(now, String(refereeId));
    if (cfg.referral.referrerDays > 0) extendPremium(db, ref.referrer_id, cfg.referral.referrerDays, now);
    if (cfg.referral.refereeDays > 0) extendPremium(db, String(refereeId), cfg.referral.refereeDays, now);
    return { referrerId: ref.referrer_id };
  });
}

function referralStats(db, id) {
  const row = db.prepare(`SELECT
      SUM(status='rewarded') AS rewarded, SUM(status='pending') AS pending FROM referrals WHERE referrer_id=?`).get(String(id));
  return { rewarded: row.rewarded || 0, pending: row.pending || 0 };
}

module.exports = { registerReferral, rewardReferral, referralStats };
