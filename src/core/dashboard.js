'use strict';
const crypto = require('node:crypto');

function createDashboardSession(db, { telegramId, ttlSec = 3600, now }) {
  const id = crypto.randomBytes(24).toString('base64url');
  const t = Number(now);
  db.prepare('INSERT INTO dashboard_sessions (id, telegram_id, expires_at, created_at) VALUES (?,?,?,?)')
    .run(id, String(telegramId), t + ttlSec, t);
  return id;
}

function getDashboardSession(db, id, now) {
  if (typeof id !== 'string' || id.length < 20 || id.length > 100) return null;
  const row = db.prepare('SELECT * FROM dashboard_sessions WHERE id=? AND used_at IS NULL AND expires_at>?').get(id, Number(now));
  return row || null;
}

function consumeDashboardSession(db, id, now) {
  return db.prepare('UPDATE dashboard_sessions SET used_at=? WHERE id=? AND used_at IS NULL').run(Number(now), id).changes > 0;
}

module.exports = { createDashboardSession, getDashboardSession, consumeDashboardSession };
