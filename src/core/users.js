'use strict';
const crypto = require('node:crypto');
const { tx } = require('../db');

const newRefCode = () => crypto.randomBytes(6).toString('base64url'); // 8 chars, valid in t.me ?start= payloads

/** Create-or-update a user. Returns { user, isNew }. */
function upsertUser(db, { id, username }, now) {
  const tid = String(id);
  const existing = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tid);
  if (existing) {
    if (username && username !== existing.username) db.prepare('UPDATE users SET username=? WHERE telegram_id=?').run(username, tid);
    if (existing.blocked_bot) db.prepare('UPDATE users SET blocked_bot=0 WHERE telegram_id=?').run(tid);
    return { user: db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tid), isNew: false };
  }
  for (let i = 0; i < 5; i++) {
    try {
      db.prepare('INSERT INTO users (telegram_id, username, ref_code, created_at) VALUES (?,?,?,?)').run(tid, username || null, newRefCode(), now);
      return { user: db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tid), isNew: true };
    } catch (e) {
      if (!/UNIQUE/.test(String(e.message)) || db.prepare('SELECT 1 FROM users WHERE telegram_id=?').get(tid)) throw e;
    }
  }
  throw new Error('Could not allocate referral code');
}

const getUser = (db, id) => db.prepare('SELECT * FROM users WHERE telegram_id=?').get(String(id));
const planOf = (user, now) => (user && user.premium_until > now ? 'premium' : 'free');

/** Premium expiry stored for admins: year 2100, i.e. no expiry in practice. */
const ADMIN_PREMIUM_UNTIL = 4102444800;
const isPermanentPremium = (until) => Number(until) >= ADMIN_PREMIUM_UNTIL;

/** Give every listed admin who already has a user row permanent premium. Safe to call repeatedly. */
function grantAdminPremium(db, adminIds) {
  const ids = (adminIds || []).map(String).filter((x) => /^\d+$/.test(x));
  if (!ids.length) return 0;
  const stmt = db.prepare('UPDATE users SET premium_until=? WHERE telegram_id=? AND premium_until<?');
  let n = 0;
  for (const id of ids) n += stmt.run(ADMIN_PREMIUM_UNTIL, id, ADMIN_PREMIUM_UNTIL).changes;
  return n;
}

/** Extend premium from max(now, current expiry). Returns the new expiry. */
function extendPremium(db, id, days, now) {
  return tx(db, () => {
    const u = getUser(db, id);
    if (!u) throw new Error('Unknown user');
    const base = Math.max(now, u.premium_until);
    const until = base + days * 86400;
    db.prepare('UPDATE users SET premium_until=? WHERE telegram_id=?').run(until, String(id));
    return until;
  });
}

/** Save the user's time zone (already validated, see util/timezone.js). null clears it back to UTC. */
function setUserTimezone(db, id, zone) {
  db.prepare('UPDATE users SET timezone=? WHERE telegram_id=?').run(zone || null, String(id));
}

function revokePremium(db, id) {
  db.prepare('UPDATE users SET premium_until=0 WHERE telegram_id=?').run(String(id));
}

module.exports = { upsertUser, getUser, planOf, extendPremium, revokePremium, setUserTimezone, grantAdminPremium, isPermanentPremium, ADMIN_PREMIUM_UNTIL };
