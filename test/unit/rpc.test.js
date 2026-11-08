'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRpc, createRateLimiter } = require('../../src/core/rpc');

const address = (n) => `0x${String(n).padStart(40, '0')}`;
const chainHex = (id) => `0x${Number(id).toString(16)}`;
const makeError = (message, code, status) => Object.assign(new Error(message), { code, status });

function chain(key = 'robinhood', chainId = 4663, rpcUrls = ['https://primary.example/rpc']) {
  return { [key]: { key, chainId, rpcUrl: rpcUrls[0], rpcUrls } };
}

test('RPC simulation forwards an explicit gas limit to eth_call', async () => {
  let callRequest;
  const fakeProvider = {
    send: async () => chainHex(4663),
    call: async (request) => { callRequest = request; return '0x'; }
  };
  const rpc = createRpc(chain(), { providerFactory: () => fakeProvider });
  const result = await rpc.simulate('robinhood', {
    from: address(1), to: address(2), data: '0x1234', value: 0n, gasLimit: '300000'
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(callRequest.gasLimit, 300000n);
});

test('transient read errors fail over to the next verified endpoint', async () => {
  const attempted = [];
  const rpc = createRpc(chain('base', 8453, ['https://primary.example/rpc', 'https://backup.example/rpc']), {
    providerFactory: (cfg) => ({
      async send(method) { if (method === 'eth_chainId') return chainHex(8453); return '0x'; },
      async getBalance() {
        attempted.push(cfg.rpcUrl);
        if (cfg.rpcUrl.includes('primary')) throw makeError('HTTP 503 Service Unavailable', 'SERVER_ERROR', 503);
        return 123n;
      }
    }),
    failureCooldownMs: 500
  });
  assert.equal(await rpc.getBalance('base', address(7)), '123');
  assert.deepEqual(attempted, ['https://primary.example/rpc', 'https://backup.example/rpc']);
  const health = rpc.health('base');
  assert.equal(health[0].consecutiveFailures, 1);
  assert.equal(health[1].verified, true);
});

test('endpoint returning the wrong chain id is quarantined before reads', async () => {
  const rpc = createRpc(chain('base', 8453, ['https://wrong.example/rpc', 'https://valid.example/rpc']), {
    providerFactory: (cfg) => ({
      async send(method) { return method === 'eth_chainId' ? chainHex(cfg.rpcUrl.includes('wrong') ? 1 : 8453) : '0x'; },
      async getBalance() { return 5n; }
    }),
    failureCooldownMs: 500
  });
  assert.equal(await rpc.getBalance('base', address(8)), '5');
  assert.equal(rpc.health('base')[0].disabled, true);
  assert.equal(rpc.health('base')[1].verified, true);
});

test('deterministic contract reverts do not fail over as infrastructure errors', async () => {
  let primaryCalls = 0; let backupCalls = 0;
  const rpc = createRpc(chain('base', 8453, ['https://primary.example/rpc', 'https://backup.example/rpc']), {
    providerFactory: (cfg) => ({
      async send(method) { return method === 'eth_chainId' ? chainHex(8453) : '0x'; },
      async call() {
        if (cfg.rpcUrl.includes('primary')) { primaryCalls += 1; throw makeError('execution reverted', 'CALL_EXCEPTION'); }
        backupCalls += 1; return '0x';
      }
    })
  });
  const result = await rpc.simulate('base', { from: address(1), to: address(2), data: '0x1234', value: 0n });
  assert.equal(result.ok, false);
  assert.match(result.reason, /execution reverted/);
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 0);
});

test('RPC request limiter enforces a token-bucket rate while preserving a small burst', async () => {
  let clock = 0;
  const waits = [];
  const limiter = createRateLimiter({
    ratePerSecond: 2, burst: 1, now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; }
  });
  await limiter.acquire();
  assert.equal(clock, 0);
  await limiter.acquire();
  assert.ok(clock >= 500);
  assert.equal(waits.length, 1);
});

test('endpoint diagnostics expose host but never credentials or query secrets', async () => {
  const secret = 'sensitive-api-key';
  const rpc = createRpc({ base: { key: 'base', chainId: 8453, rpcUrl: `https://user:${secret}@primary.example/rpc?key=${secret}` } }, {
    providerFactory: () => ({ send: async () => { throw makeError(`request failed at https://user:${secret}@primary.example/rpc?key=${secret}`, 'SERVER_ERROR'); } }),
    log: { warn() {}, info() {} }
  });
  await assert.rejects(() => rpc.provider('base'));
  const healthJson = JSON.stringify(rpc.health('base'));
  assert.match(healthJson, /primary\.example/);
  assert.doesNotMatch(healthJson, new RegExp(secret));
  assert.doesNotMatch(healthJson, /user:/);
});

// --- Launch-speed paths -------------------------------------------------------------------------
const { Wallet, Transaction } = require('ethers');

async function signedRaw() {
  const w = Wallet.createRandom();
  return w.signTransaction({ to: address(2), value: 1n, gasLimit: 21000n, nonce: 0, chainId: 4663n, type: 2, maxFeePerGas: 2n, maxPriorityFeePerGas: 0n });
}

function multiEndpoint(behaviour) {
  const urls = ['https://a.example/rpc', 'https://b.example/rpc', 'https://c.example/rpc'];
  const sent = [];
  const rpc = createRpc(chain('robinhood', 4663, urls), {
    providerFactory: (cfg) => ({
      async send(method, params) {
        if (method === 'eth_chainId') return chainHex(4663);
        if (method === 'eth_sendRawTransaction') { sent.push(cfg.rpcUrl); return behaviour(cfg.rpcUrl, params[0]); }
        if (method === 'eth_blockNumber') return '0x1';
        return '0x';
      }
    }),
    failureCooldownMs: 500
  });
  return { rpc, sent };
}

test('broadcast sends the same signed bytes to every endpoint at once and resolves on the first acceptance', async () => {
  const raw = await signedRaw();
  const { rpc, sent } = multiEndpoint(async (url) => {
    if (url.includes('a.')) { await new Promise((r) => setTimeout(r, 50)); return Transaction.from(raw).hash; }
    if (url.includes('b.')) throw makeError('socket hang up', 'NETWORK_ERROR');
    return Transaction.from(raw).hash;
  });
  const started = Date.now();
  const r = await rpc.broadcast('robinhood', raw);
  assert.equal(r.hash, Transaction.from(raw).hash);
  assert.equal(r.host, 'c.example', 'the fast endpoint wins; the slow one is not awaited');
  assert.ok(Date.now() - started < 45);
  assert.equal(r.endpoints, 3);
  assert.deepEqual(sent.sort(), ['https://a.example/rpc', 'https://b.example/rpc', 'https://c.example/rpc']);
});

test('broadcast treats "already known" as acceptance and prefers a definitive rejection when all fail', async () => {
  const raw = await signedRaw();
  const known = multiEndpoint(async () => { throw makeError('already known', 'UNKNOWN_ERROR'); });
  assert.equal((await known.rpc.broadcast('robinhood', raw)).alreadyKnown, true);
  const rejected = multiEndpoint(async (url) => {
    if (url.includes('b.')) throw makeError('nonce has already been used', 'NONCE_EXPIRED');
    throw makeError('timeout', 'TIMEOUT');
  });
  await assert.rejects(rejected.rpc.broadcast('robinhood', raw), (e) => e.code === 'NONCE_EXPIRED');
  const ambiguous = multiEndpoint(async () => { throw makeError('timeout', 'TIMEOUT'); });
  await assert.rejects(ambiguous.rpc.broadcast('robinhood', raw), (e) => e.code === 'TIMEOUT');
  const lowFee = multiEndpoint(async () => { throw makeError('could not coalesce error (error={ "message": "max fee per gas less than block base fee" })', 'UNKNOWN_ERROR'); });
  await assert.rejects(lowFee.rpc.broadcast('robinhood', raw), /less than block base fee/);
});

test('broadcast is not throttled by the read rate limiter', async () => {
  const raw = await signedRaw();
  let reads = 0;
  const rpc = createRpc(chain(), {
    rateLimitPerSecond: 1, rateLimitBurst: 1,
    providerFactory: () => ({
      async send(method) { if (method === 'eth_chainId') return chainHex(4663); if (method === 'eth_sendRawTransaction') return Transaction.from(raw).hash; return '0x'; },
      async getBalance() { reads += 1; return 1n; }
    })
  });
  await rpc.getBalance('robinhood', address(1)); // verifies the endpoint (uses the single read token)
  const started = Date.now();
  await rpc.broadcast('robinhood', raw);
  assert.ok(Date.now() - started < 200, 'a launch broadcast never waits for read tokens');
  assert.equal(reads, 1);
});

test('getFeeInputs reads the latest block and the suggested tip in one batch; legacy chains fall back to gasPrice', async () => {
  const calls = [];
  const rpc = createRpc(chain(), {
    providerFactory: () => ({
      async send(method) { calls.push(method); if (method === 'eth_chainId') return chainHex(4663); if (method === 'eth_maxPriorityFeePerGas') return '0x5'; if (method === 'eth_gasPrice') return '0x9'; return '0x'; },
      async getBlock() { calls.push('getBlock'); return { baseFeePerGas: 10n, timestamp: 1234, number: 77 }; }
    })
  });
  assert.deepEqual(await rpc.getFeeInputs('robinhood'), { baseFeePerGas: 10n, priorityFeePerGas: 5n, gasPrice: null, timestamp: 1234, number: 77 });
  assert.equal((await rpc.getFeeInputs('robinhood', { suggestTip: false })).priorityFeePerGas, null);
  const legacy = createRpc(chain(), {
    providerFactory: () => ({
      async send(method) { if (method === 'eth_chainId') return chainHex(4663); if (method === 'eth_gasPrice') return '0x9'; return '0x'; },
      async getBlock() { return { baseFeePerGas: null, timestamp: 1, number: 1 }; }
    })
  });
  assert.equal((await legacy.getFeeInputs('robinhood', { suggestTip: false })).gasPrice, 9n);
});

test('getReceipt reports gas used and confirmations; warm opens every endpoint', async () => {
  const { rpc } = multiEndpoint(async () => '0x');
  assert.equal(await rpc.warm('robinhood'), 3);
  const receiptRpc = createRpc(chain(), {
    providerFactory: () => ({
      async send(method) { return method === 'eth_chainId' ? chainHex(4663) : '0x'; },
      async getTransactionReceipt() { return { status: 0, blockNumber: 10, logs: [], gasUsed: 81234n }; },
      async getBlockNumber() { return 12; },
      async getBlock(n) { return { timestamp: 1000 + Number(n) }; }
    })
  });
  assert.deepEqual(await receiptRpc.getReceipt('robinhood', '0x' + '1'.repeat(64)), { status: 'failed', blockNumber: 10, confirmations: 3, logs: [], gasUsed: '81234' });
  assert.equal(await receiptRpc.getBlockTimestamp('robinhood', 10), 1010);
});
