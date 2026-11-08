'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyAbi, minimalProxyImplementation, discoverContract } = require('../../src/core/contractDiscovery');

const impl = '0x1111111111111111111111111111111111111111';
const proxyCode = `0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3`;

test('detects EIP-1167 minimal proxy implementation', () => {
  assert.equal(minimalProxyImplementation(proxyCode), impl);
  assert.equal(minimalProxyImplementation('0x6000'), null);
});

test('classifies verified ABI methods without enabling arbitrary calldata', () => {
  const direct = classifyAbi([{ type: 'function', name: 'mint', inputs: [{ type: 'uint256' }] }]);
  assert.equal(direct.protocol, 'direct');
  assert.deepEqual(direct.methods, ['mint(uint256)']);
  const sea = classifyAbi([{ type: 'function', name: 'mintPublic', inputs: [{ type: 'address' }, { type: 'uint256' }] }]);
  assert.equal(sea.protocol, 'seadrop');
});

test('discovers NFT metadata and standard from a read-only provider', async () => {
  const calls = [];
  const provider = {
    getCode: async () => proxyCode,
    getStorage: async () => '0x' + '0'.repeat(64),
    call: async () => '0x'
  };
  const result = await discoverContract(provider, '0x2222222222222222222222222222222222222222');
  assert.equal(result.hasCode, true);
  assert.equal(result.implementation, impl);
  assert.equal(result.verifiedAbi, false);
  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 0);
});
