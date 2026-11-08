'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { parseZone, offsetSec, localToUtc, formatWhen, describeZone, zoneLabel } = require('../../src/util/timezone');
const { parseWhen } = require('../../src/util/format');
const { openDb } = require('../../src/db');
const { upsertUser, getUser, setUserTimezone } = require('../../src/core/users');

const at = (y, mo, d, h, mi, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;

test('parseZone accepts city zones in any case, popular city names and fixed offsets', () => {
  assert.equal(parseZone('Africa/Lagos'), 'Africa/Lagos');
  assert.equal(parseZone('africa/lagos'), 'Africa/Lagos');
  assert.equal(parseZone('Lagos'), 'Africa/Lagos');
  assert.equal(parseZone('new york'), 'America/New_York');
  assert.equal(parseZone('utc'), 'UTC');
  assert.equal(parseZone('GMT'), 'UTC');
  assert.equal(parseZone('utc+1'), 'UTC+1');
  assert.equal(parseZone('GMT-5:30'), 'UTC-5:30');
  assert.equal(parseZone('UTC+0'), 'UTC');
  assert.equal(parseZone('UTC+05:30'), 'UTC+5:30');
});

test('parseZone refuses things that are not zones', () => {
  for (const bad of ['', '   ', 'Mars/Base', 'UTC+15', 'UTC+14:30', '+01:00', '5', 'hello world', 'x'.repeat(80), null, undefined]) assert.equal(parseZone(bad), null, String(bad));
});

test('offsets follow daylight saving for named zones and stay fixed for UTC±H', () => {
  assert.equal(offsetSec('America/New_York', at(2027, 1, 15, 17, 10)), -5 * 3600);
  assert.equal(offsetSec('America/New_York', at(2027, 7, 15, 17, 10)), -4 * 3600);
  assert.equal(offsetSec('Africa/Lagos', at(2027, 1, 15, 17, 10)), 3600);
  assert.equal(offsetSec('Asia/Kolkata', at(2027, 1, 15, 17, 10)), 5.5 * 3600);
  assert.equal(offsetSec('UTC-5:30', at(2027, 7, 15, 0, 0)), -5.5 * 3600);
  assert.equal(offsetSec(null, 1800000000), 0);
  assert.equal(zoneLabel('Asia/Kolkata', at(2027, 1, 15, 0, 0)), 'UTC+5:30');
  assert.equal(zoneLabel('UTC', 0), 'UTC');
});

test('localToUtc: the same wall-clock time is a different instant in each zone, and DST is respected', () => {
  assert.equal(localToUtc(2027, 1, 15, 18, 10, 'Africa/Lagos'), at(2027, 1, 15, 17, 10));
  assert.equal(localToUtc(2027, 1, 15, 18, 10, 'America/New_York'), at(2027, 1, 15, 23, 10));
  assert.equal(localToUtc(2027, 7, 15, 18, 10, 'America/New_York'), at(2027, 7, 15, 22, 10), 'summer time');
  assert.equal(localToUtc(2027, 1, 15, 18, 10, 'UTC'), at(2027, 1, 15, 18, 10));
});

test('formatWhen shows the local time with the UTC time beside it; UTC users see plain UTC', () => {
  const ts = at(2027, 1, 15, 17, 10);
  assert.equal(formatWhen(ts, 'Africa/Lagos'), '2027-01-15 18:10 UTC+1 (17:10 UTC)');
  assert.equal(formatWhen(ts, null), '2027-01-15 17:10 UTC');
  assert.equal(formatWhen(ts, 'UTC'), '2027-01-15 17:10 UTC');
  assert.equal(formatWhen(at(2027, 1, 15, 23, 30), 'Africa/Lagos'), '2027-01-16 00:30 UTC+1 (2027-01-15 23:30 UTC)', 'the UTC date is spelled out when it differs');
  assert.equal(formatWhen(ts, 'America/New_York'), '2027-01-15 12:10 UTC-5 (17:10 UTC)');
  assert.equal(describeZone('Africa/Lagos', ts), 'Lagos · Africa/Lagos · UTC+1');
  assert.equal(describeZone('UTC+5:30', ts), 'UTC+5:30');
  assert.equal(describeZone(null, ts), 'UTC');
});

test('parseWhen reads clock times and dates in the given zone; "utc" overrides it; offsets are unaffected', () => {
  const now = at(2027, 1, 15, 10, 20, 20);                          // 11:20:20 in Lagos
  assert.equal(parseWhen('5:10 pm', now, 'Africa/Lagos'), at(2027, 1, 15, 16, 10));
  assert.equal(parseWhen('17:10', now, 'Africa/Lagos'), at(2027, 1, 15, 16, 10));
  assert.equal(parseWhen('5:10 pm utc', now, 'Africa/Lagos'), at(2027, 1, 15, 17, 10));
  assert.equal(parseWhen('5:10 pm', now), at(2027, 1, 15, 17, 10), 'UTC when no zone is given');
  assert.equal(parseWhen('2027-01-20 6:30 pm', now, 'America/New_York'), at(2027, 1, 20, 23, 30));
  assert.equal(parseWhen('2027-01-20 18:30 UTC', now, 'America/New_York'), at(2027, 1, 20, 18, 30));
  assert.equal(parseWhen('+10m', now, 'Africa/Lagos'), at(2027, 1, 15, 10, 30), 'offsets do not depend on the zone');
});

test('a time that has already passed today in the user\'s zone means tomorrow in that zone', () => {
  const now = at(2027, 1, 15, 10, 20, 20);                          // 11:20 in Lagos, 05:20 in New York
  assert.equal(parseWhen('9:05 am', now, 'Africa/Lagos'), at(2027, 1, 16, 8, 5));
  assert.equal(parseWhen('9:05 am', now, 'America/New_York'), at(2027, 1, 15, 14, 5), 'still ahead in New York');
  const late = at(2027, 1, 15, 23, 30);                             // already Jan 16, 00:30 in Lagos
  assert.equal(parseWhen('1 am', late, 'Africa/Lagos'), at(2027, 1, 16, 0, 0), '1 am Lagos is 00:00 UTC on the 16th');
});

test('the invalid-time message names the zone in use', () => {
  assert.throws(() => parseWhen('nope', at(2027, 1, 15, 10, 0), 'Africa/Lagos'), /\(UTC\+1\)/);
  assert.throws(() => parseWhen('nope', at(2027, 1, 15, 10, 0)), /\(UTC\)/);
});

test('migration: users get a nullable timezone column; saving, reading and clearing it works', () => {
  const db = openDb(':memory:');
  assert.ok(db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'timezone'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
  upsertUser(db, { id: 1, username: 'a' }, 1);
  assert.equal(getUser(db, 1).timezone, null);
  setUserTimezone(db, 1, 'Africa/Lagos');
  assert.equal(getUser(db, 1).timezone, 'Africa/Lagos');
  setUserTimezone(db, 1, null);
  assert.equal(getUser(db, 1).timezone, null);
});

test('migration: an existing v12 database with users in it upgrades without losing anything', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-tz-')), 'old.db');
  const first = openDb(file);
  upsertUser(first, { id: 7, username: 'old-user' }, 5);
  first.close();
  const raw = new DatabaseSync(file);                                // wind it back to how a v12 database looks
  raw.exec('ALTER TABLE users DROP COLUMN timezone; PRAGMA user_version = 12;');
  raw.close();
  const upgraded = openDb(file);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 13);
  const u = getUser(upgraded, 7);
  assert.equal(u.username, 'old-user'); assert.equal(u.timezone, null);
  upgraded.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
