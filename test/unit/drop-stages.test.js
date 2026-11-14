'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeStages, describeStages, supplyLine } = require('../../src/core/dropStages');

// A real drop (Robinhood Chain, "Jpegs Are Dead"): four allowlist stages sold the supply before the next one opened.
const drop = {
  stages: [
    { stage_type: 'public_sale', label: 'NO PUBLIC', price: '69000000000000000000', price_currency_address: '0x0000000000000000000000000000000000000000', start_time: '2026-11-13T19:00:00Z', end_time: '2026-11-13T19:01:00Z', max_per_wallet: '1000', allowlist_wallet_count: null },
    { stage_type: 'signed_presale', label: 'VAULT', price: '0', price_currency_address: '0x0000000000000000000000000000000000000000', start_time: '2026-11-13T13:40:00Z', end_time: '2026-11-13T14:00:00Z', max_per_wallet: '69', allowlist_wallet_count: 1 },
    { stage_type: 'signed_presale', label: 'GTD', price: '0', price_currency_address: '0x0000000000000000000000000000000000000000', start_time: '2026-11-13T16:00:00Z', end_time: '2026-11-13T17:00:00Z', max_per_wallet: '1', allowlist_wallet_count: 1920 },
    { stage_type: 'signed_presale', label: 'FCFS: NORMIES + TMO RH', price: '0', price_currency_address: '0x0000000000000000000000000000000000000000', start_time: '2026-11-13T17:00:00Z', end_time: '2026-11-13T18:00:00Z', max_per_wallet: '1', allowlist_wallet_count: 6562 },
    { stage_type: 'signed_presale', label: 'FCFS: COLLECTIONS', price: '0', price_currency_address: '0x0000000000000000000000000000000000000000', start_time: '2026-11-13T18:00:00Z', end_time: '2026-11-13T19:00:00Z', max_per_wallet: '1', allowlist_wallet_count: 15478 }
  ]
};
const at = (iso) => Math.floor(Date.parse(iso) / 1000);

test('stages come back oldest first with epoch times and readable fields', () => {
  const s = normalizeStages(drop);
  assert.deepEqual(s.map((x) => x.label), ['VAULT', 'GTD', 'FCFS: NORMIES + TMO RH', 'FCFS: COLLECTIONS', 'NO PUBLIC']);
  assert.equal(s[0].start, at('2026-11-13T13:40:00Z'));
  assert.equal(s[3].type, 'allowlist');
  assert.equal(s[3].wallets, 15478);
  assert.equal(s[4].type, 'public');
  assert.equal(s[4].priceWei, '69000000000000000000');
  assert.deepEqual(normalizeStages({}), []);
});

test('the timeline shows the live stage, what comes next and the allowlist caveat', () => {
  const text = describeStages(normalizeStages(drop), at('2026-11-13T17:23:23Z'));
  assert.match(text, /🟢 <b>FCFS: NORMIES \+ TMO RH<\/b>: 17:00–18:00 UTC, allowlist \(6,562 wallets\), 1 per wallet, free/);
  assert.match(text, /⏳ <b>FCFS: COLLECTIONS<\/b>: 18:00–19:00 UTC, allowlist \(15,478 wallets\)/);
  assert.match(text, /⏳ <b>NO PUBLIC<\/b>: 19:00–19:01 UTC, public sale, 1000 per wallet, 69 ETH/);
  assert.match(text, /⏹ <b>GTD<\/b>/);
  assert.doesNotMatch(text, /VAULT/, 'only the most recent finished stage is shown');
  assert.match(text, /cannot check that before a stage opens/);
});

test('labels are escaped for the chat message', () => {
  const text = describeStages(normalizeStages({ stages: [{ stage_type: 'public_sale', label: '<b>x</b> & y', price: '0', start_time: '2026-11-13T19:00:00Z', end_time: '2026-11-13T20:00:00Z' }] }), at('2026-11-13T10:00:00Z'));
  assert.match(text, /&lt;b&gt;x&lt;\/b&gt; &amp; y/);
});

test('supply line warns when little is left', () => {
  assert.match(supplyLine({ minted: '3898', max: '3969' }), /3,898 of 3,969 \(71 left\)[\s\S]*⚠️ Not much is left/);
  assert.doesNotMatch(supplyLine({ minted: '100', max: '3969' }), /⚠️/);
  assert.equal(supplyLine(null), '');
  assert.equal(supplyLine({ minted: '0', max: '0' }), '');
});
