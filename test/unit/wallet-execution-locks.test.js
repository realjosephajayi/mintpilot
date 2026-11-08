'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../../src/db');
const { createWalletExecutionLocks } = require('../../src/core/walletExecutionLocks');
const { A } = require('./helpers');

test('SQLite wallet leases are exclusive across database connections and recover after expiry', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintpilot-wallet-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mintpilot.sqlite');
  const dbA = openDb(file);
  const dbB = openDb(file);
  t.after(() => { dbA.close(); dbB.close(); });

  let clock = 1000;
  const locksA = createWalletExecutionLocks({ db: dbA, ttlSec: 30, now: () => clock, tokenFactory: () => 'owner-a' });
  const locksB = createWalletExecutionLocks({ db: dbB, ttlSec: 30, now: () => clock, tokenFactory: () => 'owner-b' });
  const leaseA = locksA.acquire(A(7));
  assert.ok(leaseA);
  assert.equal(locksB.acquire(A(7).toUpperCase()), null);
  assert.equal(locksB.owns(leaseA), true);
  assert.equal(locksB.renew({ ...leaseA, token: 'wrong-token' }), false);
  assert.equal(locksB.release({ ...leaseA, token: 'wrong-token' }), false);

  assert.equal(locksA.renew(leaseA), true);
  assert.equal(leaseA.leaseUntil, 1030);
  clock = 1031;
  const leaseB = locksB.acquire(A(7));
  assert.ok(leaseB);
  assert.equal(locksA.renew(leaseA), false);
  assert.equal(locksA.release(leaseA), false);
  assert.equal(locksB.owns(leaseB), true);
  assert.equal(locksB.release(leaseB), true);
  assert.equal(locksA.acquire(A(7))?.token, 'owner-a');
});
