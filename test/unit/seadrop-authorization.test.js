'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSeaDropRouterAuthorized } = require('../../src/core/seaDropAuthorization');
const { MintSpecError } = require('../../src/core/errors');

const schedule = { chain: 'robinhood', contract: '0x1111111111111111111111111111111111111111' };
const tx = { to: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' };
const rpcThat = (behaviour) => ({ getAllowedSeaDrop: async () => behaviour() });

test('a listed router passes', async () => {
  assert.equal(await assertSeaDropRouterAuthorized(rpcThat(() => [tx.to.toLowerCase()]), schedule, tx), true);
});

test('a network failure stays retryable', async () => {
  await assert.rejects(assertSeaDropRouterAuthorized(rpcThat(() => { throw new Error('request timed out'); }), schedule, tx), (e) => e.retryable === true && !(e instanceof MintSpecError));
});

test('a contract that does not publish the list fails at once with a clear message instead of retrying forever', async () => {
  for (const code of ['CALL_EXCEPTION', 'BAD_DATA']) {
    await assert.rejects(assertSeaDropRouterAuthorized(rpcThat(() => { throw Object.assign(new Error('could not decode result data'), { code }); }), schedule, tx), (e) => e instanceof MintSpecError && /does not publish a SeaDrop authorization list/.test(e.message) && !e.retryable);
  }
});

test('an unlisted router is refused', async () => {
  await assert.rejects(assertSeaDropRouterAuthorized(rpcThat(() => ['0x2222222222222222222222222222222222222222']), schedule, tx), (e) => e instanceof MintSpecError && /not authorized/.test(e.message));
});
