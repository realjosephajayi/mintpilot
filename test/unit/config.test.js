'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config');
const { getChains } = require('../../src/chains');

test('automatic wallet concurrency defaults to four and accepts values from one through sixteen', () => {
  assert.equal(loadConfig({}).automation.maxConcurrentWallets, 4);
  assert.equal(loadConfig({ AUTOMATION_MAX_CONCURRENT_WALLETS: '1' }).automation.maxConcurrentWallets, 1);
  assert.equal(loadConfig({ AUTOMATION_MAX_CONCURRENT_WALLETS: '16' }).automation.maxConcurrentWallets, 16);
});

test('automatic wallet concurrency rejects zero and values above sixteen', () => {
  assert.throws(() => loadConfig({ AUTOMATION_MAX_CONCURRENT_WALLETS: '0' }), /between 1 and 16/);
  assert.throws(() => loadConfig({ AUTOMATION_MAX_CONCURRENT_WALLETS: '17' }), /between 1 and 16/);
});

test('RPC pool settings default safely and validate fallback endpoint URLs', () => {
  const cfg = loadConfig({});
  assert.deepEqual(cfg.rpc, { rateLimitPerSecond: 10, rateLimitBurst: 5, failureCooldownMs: 5000, timeoutMs: 8000 });
  assert.deepEqual(cfg.rpcFallbackUrls, {});
  const configured = loadConfig({ RPC_FALLBACK_URLS_JSON: '{"base":["https://backup.example/rpc"]}', RPC_RATE_LIMIT_PER_SECOND: '20', RPC_RATE_LIMIT_BURST: '8' });
  assert.deepEqual(configured.rpcFallbackUrls.base, ['https://backup.example/rpc']);
  assert.equal(configured.rpc.rateLimitPerSecond, 20);
  assert.equal(configured.rpc.rateLimitBurst, 8);
  const registry = getChains(loadConfig({ BASE_RPC_URL: 'https://primary.example/rpc', RPC_FALLBACK_URLS_JSON: '{"base":["https://backup.example/rpc","https://backup.example/rpc"]}' }));
  assert.equal(registry.base.rpcUrl, 'https://primary.example/rpc');
  assert.deepEqual(registry.base.rpcUrls, ['https://primary.example/rpc', 'https://backup.example/rpc']);
  assert.throws(() => loadConfig({ RPC_FALLBACK_URLS_JSON: '{"base":["http://rpc.example"]}' }), /must use HTTPS/);
  assert.throws(() => loadConfig({ RPC_FALLBACK_URLS_JSON: '{"not-a-chain":[]}' }), /configured chain/);
});

test('RPC and wallet lock limits reject unsafe out-of-range values', () => {
  assert.throws(() => loadConfig({ RPC_RATE_LIMIT_PER_SECOND: '0' }), /RPC_RATE_LIMIT_PER_SECOND/);
  assert.throws(() => loadConfig({ RPC_RATE_LIMIT_BURST: '1001' }), /RPC_RATE_LIMIT_BURST/);
  assert.throws(() => loadConfig({ RPC_FAILURE_COOLDOWN_MS: '100' }), /RPC_FAILURE_COOLDOWN_MS/);
  assert.throws(() => loadConfig({ AUTOMATION_WALLET_LOCK_TTL_SECONDS: '10' }), /AUTOMATION_WALLET_LOCK_TTL_SECONDS/);
  assert.equal(loadConfig({}).automation.walletLockTtlSec, 120);
});

test('OpenSea API key is optional and normalized from server environment only', () => {
  assert.equal(loadConfig({}).openSeaApiKey, '');
  assert.equal(loadConfig({ OPENSEA_API_KEY: '  server-key  ' }).openSeaApiKey, 'server-key');
});

test('eligibility providers: kind required, HTTPS enforced, legacy SeaDrop variable maps to seadrop-signed', () => {
  const cfg = loadConfig({
    ELIGIBILITY_PROVIDERS_JSON: '{"proofs":{"kind":"merkle","url":"https://issuer.example/proof"}}',
    SEADROP_SIGNATURE_PROVIDERS_JSON: '{"legacy":{"url":"https://issuer.example/sig","method":"post","headers":{"authorization":"Bearer x"}}}'
  });
  assert.equal(cfg.eligibilityProviders.proofs.kind, 'merkle');
  assert.equal(cfg.eligibilityProviders.proofs.method, 'GET');
  assert.equal(cfg.eligibilityProviders.legacy.kind, 'seadrop-signed');
  assert.equal(cfg.eligibilityProviders.legacy.method, 'POST');
  assert.throws(() => loadConfig({ ELIGIBILITY_PROVIDERS_JSON: '{"p":{"url":"https://x.example"}}' }), /kind must be/);
  assert.throws(() => loadConfig({ ELIGIBILITY_PROVIDERS_JSON: '{"p":{"kind":"merkle","url":"http://x.example"}}' }), /must use HTTPS/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', ELIGIBILITY_PROVIDERS_JSON: '{"p":{"kind":"merkle","url":"http://127.0.0.1:9"}}' }), /must use HTTPS\./);
  assert.doesNotThrow(() => loadConfig({ ELIGIBILITY_PROVIDERS_JSON: '{"p":{"kind":"merkle","url":"http://127.0.0.1:9"}}' }));
  assert.throws(() => loadConfig({ ELIGIBILITY_PROVIDERS_JSON: '{"p":{"kind":"merkle","url":"https://x.example","headers":{"a":1}}}' }), /headers must be an object of strings/);
  assert.throws(() => loadConfig({ ELIGIBILITY_PROVIDERS_JSON: '{"p":{"kind":"merkle","url":"https://x.example","chain":"mars"}}' }), /configured chain key/);
  assert.throws(() => loadConfig({ ELIGIBILITY_PROVIDERS_JSON: '{"legacy":{"kind":"merkle","url":"https://x.example"}}', SEADROP_SIGNATURE_PROVIDERS_JSON: '{"legacy":{"url":"https://y.example"}}' }), /configured twice/);
});

test('automation defaults are off/dry-run and allowed chains must exist (review #16)', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.automation.enabled, false);
  assert.equal(cfg.automation.dryRun, true);
  assert.equal('mainnetEnabled' in cfg.automation, false);
  assert.deepEqual(cfg.automation.allowedChains, ['ethereum', 'base', 'ink', 'robinhood', 'arbitrum', 'optimism', 'zora', 'shape', 'unichain', 'soneium']);
  assert.throws(() => loadConfig({ AUTOMATION_ALLOWED_CHAINS: 'base,mars' }), /unknown chain: mars/);
  assert.throws(() => loadConfig({ AUTOMATION_ALLOWED_CHAINS: 'base-sepolia' }), /unknown chain: base-sepolia/);
});

test('mainnet-only: removed testnet settings warn, and AUTOMATION_MAINNET_ENABLED=false can never be silently ignored', () => {
  const legacy = loadConfig({ ENABLE_TESTNETS: 'true', BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org', ENABLE_LOCALNET: 'false', AUTOMATION_MAINNET_ENABLED: 'false' });
  assert.equal(legacy.warnings.length, 3);
  assert.match(legacy.warnings.join('\n'), /ENABLE_TESTNETS is no longer used/);
  assert.equal('enableTestnets' in legacy, false);
  // It used to block live mainnet signing: with live signing on, refuse to start rather than sign.
  assert.throws(() => loadConfig({ AUTOMATION_ENABLED: 'true', AUTOMATION_DRY_RUN: 'false', AUTOMATION_MAINNET_ENABLED: 'false' }), /AUTOMATION_MAINNET_ENABLED=false/);
  assert.doesNotThrow(() => loadConfig({ AUTOMATION_ENABLED: 'true', AUTOMATION_DRY_RUN: 'true', AUTOMATION_MAINNET_ENABLED: 'false' }));
  assert.deepEqual(loadConfig({}).warnings, []);
});

test('every registry chain reads its RPC from <KEY>_RPC_URL; per-chain gas caps and client-IP header are validated', () => {
  const cfg = loadConfig({ ARBITRUM_RPC_URL: 'https://arb.example/rpc', SONEIUM_RPC_URL: 'https://son.example/rpc' });
  const chains = getChains(cfg);
  assert.equal(chains.arbitrum.rpcUrl, 'https://arb.example/rpc');
  assert.equal(chains.soneium.rpcUrl, 'https://son.example/rpc');
  assert.equal(chains.zora.rpcUrl, 'https://rpc.zora.energy');
  for (const c of Object.values(chains)) {
    assert.equal(c.currency, 'ETH', `${c.key} uses ETH so the ETH caps hold`);
    assert.ok(c.opensea && c.abiApi && ['fcfs', 'fee'].includes(c.ordering), `${c.key} is fully described`);
    assert.equal('testnet' in c, false);
  }
  assert.deepEqual(loadConfig({ GAS_CAP_JSON: '{"arbitrum":{"base":800000}}' }).gas.byChain, { arbitrum: { base: 800000 } });
  assert.throws(() => loadConfig({ GAS_CAP_JSON: '{"mars":{"base":1}}' }), /not a configured chain/);
  assert.throws(() => loadConfig({ GAS_CAP_JSON: '{"base":{"limit":1}}' }), /base or perToken/);
  assert.equal(loadConfig({ CLIENT_IP_HEADER: 'CF-Connecting-IP' }).clientIpHeader, 'cf-connecting-ip');
  assert.throws(() => loadConfig({ CLIENT_IP_HEADER: 'x-forwarded-for' }), /CLIENT_IP_HEADER/);
});

test('proxy hops, launch timing and gas policy settings are validated', () => {
  assert.equal(loadConfig({}).trustProxyHops, 0);
  assert.equal(loadConfig({ TRUST_PROXY: 'true' }).trustProxyHops, 1);
  assert.equal(loadConfig({ TRUST_PROXY_HOPS: '2' }).trustProxyHops, 2);
  assert.throws(() => loadConfig({ TRUST_PROXY_HOPS: '9' }), /TRUST_PROXY_HOPS/);
  const cfg = loadConfig({});
  assert.deepEqual(cfg.launch, {
    graceSec: 120, maxWaitSec: 21600, engine: true, armSec: 60, fireOffsetMs: 50, hotWindowSec: 120, retryIntervalMs: 250,
    receiptPollMs: 200, receiptWatchSec: 60, maxChainRetries: 3, maxSessions: 100, armedFeeMultiplierBps: 30000
  });
  assert.equal(cfg.workerTickMs, 5000);
  assert.deepEqual(cfg.fees, { baseMultiplierBps: 20000, priorityFeeGwei: {} });
  assert.deepEqual(cfg.gas, { capBase: 300000, capPerToken: 100000, byChain: {}, estimateMultiplierBps: 12500 });
  assert.throws(() => loadConfig({ GAS_ESTIMATE_MULTIPLIER_BPS: '9000' }), /GAS_ESTIMATE_MULTIPLIER_BPS/);
  assert.throws(() => loadConfig({ LAUNCH_MAX_WAIT_SECONDS: '10' }), /LAUNCH_MAX_WAIT_SECONDS/);
});

test('launch engine and fee settings are validated', () => {
  assert.equal(loadConfig({ LAUNCH_ENGINE: 'false' }).launch.engine, false);
  assert.equal(loadConfig({ LAUNCH_FIRE_OFFSET_MS: '-200' }).launch.fireOffsetMs, -200);
  assert.throws(() => loadConfig({ LAUNCH_FIRE_OFFSET_MS: '-5000' }), /LAUNCH_FIRE_OFFSET_MS/);
  assert.throws(() => loadConfig({ LAUNCH_RETRY_INTERVAL_MS: '10' }), /LAUNCH_RETRY_INTERVAL_MS/);
  assert.throws(() => loadConfig({ LAUNCH_MAX_CHAIN_RETRIES: '11' }), /LAUNCH_MAX_CHAIN_RETRIES/);
  // The tick must reach a schedule inside its arming window.
  assert.throws(() => loadConfig({ LAUNCH_ARM_SECONDS: '10', WORKER_TICK_MS: '6000' }), /at least two WORKER_TICK_MS/);
  assert.equal(loadConfig({ LAUNCH_ARM_SECONDS: '10', WORKER_TICK_MS: '5000' }).launch.armSec, 10);
  assert.deepEqual(loadConfig({ PRIORITY_FEE_GWEI_JSON: '{"base":"0.05","robinhood":0}' }).fees.priorityFeeGwei, { base: '0.05', robinhood: 0 });
  assert.throws(() => loadConfig({ PRIORITY_FEE_GWEI_JSON: '{"mars":"1"}' }), /not a configured chain/);
  assert.throws(() => loadConfig({ PRIORITY_FEE_GWEI_JSON: '{"base":"-1"}' }), /non-negative gwei/);
  assert.throws(() => loadConfig({ PRIORITY_FEE_GWEI_JSON: '{"base":"0.0000000001"}' }), /at most 9 decimals/);
});
