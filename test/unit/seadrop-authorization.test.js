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
    await assert.rejects(assertSeaDropRouterAuthorized(rpcThat(() => { throw Object.assign(new Error('could not decode result data'), { code }); }), schedule, tx, { mode: 'strict' }), (e) => e instanceof MintSpecError && /does not publish a SeaDrop authorization list/.test(e.message) && /0x00005EA00Ac477B1030CE78506496e8C2dE24bf5/.test(e.message) && !e.retryable);
  }
});

test('an unlisted router is refused', async () => {
  await assert.rejects(assertSeaDropRouterAuthorized(rpcThat(() => ['0x2222222222222222222222222222222222222222']), schedule, tx), (e) => e instanceof MintSpecError && /not authorized/.test(e.message));
});

test('a contract without a router list is accepted when OpenSea sends the mint to the contract itself', async () => {
  const revert = () => { throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }); };
  assert.equal(await assertSeaDropRouterAuthorized(rpcThat(revert), schedule, { to: schedule.contract.toUpperCase().replace('0X', '0x') }), true);
});

test('a contract without a router list is accepted for a router the operator trusted, and refused for any other', async () => {
  const revert = () => { throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }); };
  assert.equal(await assertSeaDropRouterAuthorized(rpcThat(revert), schedule, tx, { trustedRouters: [tx.to.toLowerCase()] }), true);
  await assert.rejects(assertSeaDropRouterAuthorized(rpcThat(revert), schedule, tx, { mode: 'strict', trustedRouters: ['0x3333333333333333333333333333333333333333'] }), (e) => e instanceof MintSpecError);
});

test('lenient mode (the default) trusts OpenSea\'s transaction when it goes to a deployed contract and the contract publishes no list', async () => {
  const revert = () => { throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }); };
  const rpc = { getAllowedSeaDrop: async () => revert(), hasCode: async () => true };
  assert.equal(await assertSeaDropRouterAuthorized(rpc, schedule, tx), true);
});

test('lenient mode still refuses a destination that is not a contract, and retries when that cannot be read', async () => {
  const revert = () => { throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }); };
  await assert.rejects(assertSeaDropRouterAuthorized({ getAllowedSeaDrop: async () => revert(), hasCode: async () => false }, schedule, tx), (e) => e instanceof MintSpecError && /not a contract/.test(e.message));
  await assert.rejects(assertSeaDropRouterAuthorized({ getAllowedSeaDrop: async () => revert(), hasCode: async () => { throw new Error('timeout'); } }, schedule, tx), (e) => e.retryable === true);
});

test('when the contract does publish a list, an unlisted router is refused in every mode', async () => {
  for (const mode of ['lenient', 'strict']) {
    await assert.rejects(assertSeaDropRouterAuthorized({ getAllowedSeaDrop: async () => ['0x2222222222222222222222222222222222222222'], hasCode: async () => true }, schedule, tx, { mode }), (e) => e instanceof MintSpecError && /not authorized/.test(e.message));
  }
});
