'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { remainingFromMessage } = require('../../src/core/outcomes');

test('OpenSea says how many mints are left when the request is too large', () => {
  assert.equal(remainingFromMessage("OpenSea REST OpenSea mint precondition failed: Requested quantity is more than can be minted: 1 mint remains, counting both the drop's supply and this wallet's limit for the active stage."), 1);
  assert.equal(remainingFromMessage('Requested quantity is more than can be minted: 3 mints remain, counting both the supply and the limit.'), 3);
  assert.equal(remainingFromMessage('This wallet cannot mint any more from this drop.'), null);
  assert.equal(remainingFromMessage(''), null);
  assert.equal(remainingFromMessage(undefined), null);
});
