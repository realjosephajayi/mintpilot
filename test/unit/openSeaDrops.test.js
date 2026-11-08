'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getOpenSeaDrop, assertDropMatchesSchedule, buildOpenSeaMintTransaction, validateSlug, requestJson } = require('../../src/core/openSeaDrops');

const contract = '0x1111111111111111111111111111111111111111';
const drop = { collection_slug: 'example-drop', chain: 'base', contract_address: contract, drop_type: 'seadrop_v1_erc721', fee_bps: 1000, is_minting: true };
const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body
});

test('OpenSea REST drop lookup sends server API key and validates the returned SeaDrop metadata', async () => {
  let call;
  const result = await getOpenSeaDrop('example-drop', {
    cfg: { openSeaApiKey: 'secret-server-key' },
    fetchImpl: async (url, options) => { call = { url, options }; return response(200, drop); }
  });
  assert.equal(result.contract_address, contract);
  assert.equal(call.url, 'https://api.opensea.io/api/v2/drops/example-drop');
  assert.equal(call.options.headers['x-api-key'], 'secret-server-key');
  assert.equal(call.options.headers.authorization, undefined);
  assert.equal(call.options.method, 'GET');
});

test('metadata setup binds requested slug, contract, chain, and ERC-721 SeaDrop V1 type', () => {
  assert.equal(assertDropMatchesSchedule(drop, { chain: 'base', contract }, 'example-drop'), drop);
  assert.throws(() => assertDropMatchesSchedule(drop, { chain: 'ethereum', contract }, 'example-drop'), /selected.*network/);
  assert.throws(() => assertDropMatchesSchedule(drop, { chain: 'base', contract: '0x2222222222222222222222222222222222222222' }, 'example-drop'), /selected NFT contract/);
  assert.throws(() => assertDropMatchesSchedule({ ...drop, drop_type: 'seadrop_v2_erc1155_self_mint' }, { chain: 'base', contract }, 'example-drop'), /ERC-721 SeaDrop V1/);
  assert.throws(() => assertDropMatchesSchedule(drop, { chain: 'base', contract }, 'other-drop'), /slug/);
});

test('OpenSea mint builder posts only minter and quantity to the drop mint endpoint', async () => {
  let call;
  const payload = { chain: 'base', to: contract, data: '0x12345678', value: '99' };
  const result = await buildOpenSeaMintTransaction('example-drop', {
    cfg: { openSeaApiKey: 'server-key' }, minter: contract, quantity: 3,
    fetchImpl: async (url, options) => { call = { url, options }; return response(200, payload); }
  });
  assert.deepEqual(result, payload);
  assert.equal(call.url, 'https://api.opensea.io/api/v2/drops/example-drop/mint');
  assert.equal(call.options.method, 'POST');
  assert.deepEqual(JSON.parse(call.options.body), { minter: contract, quantity: 3 });
  assert.equal(call.options.headers['x-api-key'], 'server-key');
});

test('OpenSea client rejects unsafe slugs, missing credentials, and non-retryable eligibility errors', async () => {
  assert.throws(() => validateSlug('../not-a-slug'), /slug/);
  await assert.rejects(() => getOpenSeaDrop('example-drop', { cfg: {} }), /OPENSEA_API_KEY/);
  await assert.rejects(() => buildOpenSeaMintTransaction('example-drop', {
    cfg: { openSeaApiKey: 'key-422' }, minter: contract, quantity: 1,
    fetchImpl: async () => response(422, { errors: ['wallet is not on this stage allowlist'] })
  }), (e) => e.status === 422 && e.retryable === false && /allowlist/.test(e.message));
});

test('OpenSea rate limits are retryable and enforce Retry-After cooldown without an immediate second request', async () => {
  let calls = 0;
  const cfg = { openSeaApiKey: 'unique-rate-limit-key' };
  await assert.rejects(() => requestJson('/drops/example-drop', {
    cfg,
    fetchImpl: async () => { calls += 1; return response(429, { errors: ['slow down'] }, { 'retry-after': '2' }); }
  }), (e) => e.status === 429 && e.retryable && e.retryAfterSec === 2);
  await assert.rejects(() => requestJson('/drops/example-drop', { cfg, fetchImpl: async () => { calls += 1; return response(200, drop); } }), (e) => e.status === 429 && e.retryable);
  assert.equal(calls, 1);
});

test('OpenSea requests sharing one API key are serialized within the process', async () => {
  let inFlight = 0;
  let maximumInFlight = 0;
  const cfg = { openSeaApiKey: 'unique-serialized-key' };
  const fetchImpl = async () => {
    inFlight += 1;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return response(200, { ok: true });
  };
  await Promise.all([
    requestJson('/one', { cfg, fetchImpl }),
    requestJson('/two', { cfg, fetchImpl }),
    requestJson('/three', { cfg, fetchImpl })
  ]);
  assert.equal(maximumInFlight, 1);
});
