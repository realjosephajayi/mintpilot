'use strict';
const { getUser, planOf } = require('./users');

function limitsFor(cfg, db, id, now) {
  const plan = planOf(getUser(db, id), now);
  return { plan, ...cfg.plans[plan] };
}

module.exports = { limitsFor };
