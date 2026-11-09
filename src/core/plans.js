'use strict';
const { getUser, planOf } = require('./users');

const isAdmin = (cfg, id) => cfg.adminIds.includes(String(id));

function limitsFor(cfg, db, id, now) {
  if (isAdmin(cfg, id)) {
    return { plan: 'admin', activeSchedules: Infinity, wallets: Infinity, pendingTxs: Infinity, preReminders: true };
  }
  const plan = planOf(getUser(db, id), now);
  return { plan, ...cfg.plans[plan] };
}

module.exports = { isAdmin, limitsFor };
