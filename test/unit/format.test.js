'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEth, formatWei, parseWhen, looksLikeSecret, esc } = require('../../src/util/format');
const { T0 } = require('./helpers');

test('parseEth / formatWei are exact and strict', () => {
  assert.equal(parseEth('0.01'), 10n ** 16n);
  assert.equal(parseEth('1'), 10n ** 18n);
  assert.equal(parseEth('0.000000000000000001'), 1n);
  assert.equal(formatWei(parseEth('0.0125')), '0.0125');
  assert.equal(formatWei(0n), '0');
  for (const bad of ['-1', '1e18', '0.0000000000000000001', 'abc', '', '1,5']) assert.throws(() => parseEth(bad), bad);
});

test('parseWhen: relative, absolute UTC, unix; rejects past/far/invalid', () => {
  assert.equal(parseWhen('+2h', T0), T0 + 7200);
  assert.equal(parseWhen('+30m', T0), T0 + 1800);
  assert.equal(parseWhen('+1d', T0), T0 + 86400);
  assert.equal(parseWhen('2027-01-15 18:00 UTC', 1_790_000_000), Date.UTC(2027, 0, 15, 18, 0) / 1000);
  assert.equal(parseWhen('1800003600', T0), 1800003600);
  assert.throws(() => parseWhen('+10s', T0));
  assert.throws(() => parseWhen('1700000000', T0), /future/);
  assert.throws(() => parseWhen('+9999d', T0));
  assert.throws(() => parseWhen('2027-02-31 10:00', 1_790_000_000), /does not exist/);
  assert.throws(() => parseWhen('tomorrow', T0));
});

test('looksLikeSecret catches private keys and mnemonics but not normal text', () => {
  assert.equal(looksLikeSecret('0x' + 'a'.repeat(64)), 'private_key');
  assert.equal(looksLikeSecret('b'.repeat(64)), 'private_key');
  assert.equal(looksLikeSecret('abandon ability able about above absent absorb abstract absurd abuse access accident'), 'seed_phrase');
  assert.equal(looksLikeSecret('hello this is a normal sentence'), null);
  assert.equal(looksLikeSecret('0x' + 'a'.repeat(40)), null); // an address is fine
});

test('esc escapes HTML', () => assert.equal(esc('<b>&'), '&lt;b&gt;&amp;'));
