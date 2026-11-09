'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isMintedOut, readMintedOut } = require('../../src/core/supply');

const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const rpcFor = (total, max) => ({
  ethCall: async (_chain, _to, data) => {
    const value = data.startsWith('0x18160ddd') ? total : max; // totalSupply() selector
    if (value == null) throw new Error('execution reverted');
    return word(value);
  }
});

test('isMintedOut needs both numbers and a real cap', () => {
  assert.equal(isMintedOut('699', '699'), true);
  assert.equal(isMintedOut('700', '699'), true);
  assert.equal(isMintedOut('0', '699'), false);
  assert.equal(isMintedOut('5', '0'), false);
  assert.equal(isMintedOut(null, '699'), false);
  assert.equal(isMintedOut('699', undefined), false);
});

test('readMintedOut reports a fully minted collection and stays quiet otherwise', async () => {
  assert.deepEqual(await readMintedOut(rpcFor(699, 699), 'base', '0x1111111111111111111111111111111111111111'), { minted: '699', max: '699' });
  assert.equal(await readMintedOut(rpcFor(10, 699), 'base', '0x1111111111111111111111111111111111111111'), null);
  assert.equal(await readMintedOut(rpcFor(null, 699), 'base', '0x1111111111111111111111111111111111111111'), null); // unreadable: never guess
  assert.equal(await readMintedOut({}, 'base', '0x1111111111111111111111111111111111111111'), null);
});

test('an ineligible OpenSea wallet is told plainly that it is not on the allowlist', () => {
  const { classifyPreparationError, OUTCOME } = require('../../src/core/outcomes');
  const e = Object.assign(new Error('OpenSea REST OpenSea mint precondition failed: Minter is not on the allowlist.'), { name: 'OpenSeaApiError', status: 422, apiCode: 'MINTER_NOT_ELIGIBLE', retryable: false });
  const r = classifyPreparationError(e);
  assert.equal(r.outcome, OUTCOME.TERMINAL);
  assert.equal(r.ineligible, true);
  assert.match(r.userReason, /not on the allowlist/);
});
