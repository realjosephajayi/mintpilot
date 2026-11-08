'use strict';
// Node 22 can load .env natively; ignore if the file is absent.
try { process.loadEnvFile(); } catch { /* no .env file */ }
const { DEFS, rpcEnvName } = require('./chains');

const PROVIDER_KINDS = new Set(['merkle', 'signature', 'seadrop-signed']);
// Trusted single-value client-IP headers set by an edge we control (never by the client).
const CLIENT_IP_HEADERS = new Set(['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'fly-client-ip']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']); // URL.hostname keeps IPv6 brackets

/** HTTPS everywhere; plain HTTP only for localhost and only outside production. */
function assertProviderUrl(rawUrl, label, isProduction) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error(`${label} has an invalid URL.`); }
  if (parsed.protocol === 'https:') return;
  if (!isProduction && parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname)) return;
  throw new Error(`${label} must use HTTPS${isProduction ? '' : ' (HTTP is allowed only for localhost outside production)'}.`);
}

function loadConfig(env = process.env) {
  const isProduction = (env.NODE_ENV || 'development') === 'production';
  const int = (key, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
    return n;
  };
  const bool = (key, def) => (env[key] === undefined || env[key] === '' ? def : env[key] === 'true');
  const jsonObject = (key, def = {}) => {
    if (env[key] === undefined || env[key] === '') return def;
    let value;
    try { value = JSON.parse(env[key]); } catch { throw new Error(`${key} must be valid JSON.`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be a JSON object.`);
    return value;
  };

  const knownChains = new Set(Object.keys(DEFS));
  const rpcFallbackUrls = jsonObject('RPC_FALLBACK_URLS_JSON');
  for (const [chain, urls] of Object.entries(rpcFallbackUrls)) {
    if (!knownChains.has(chain) || !Array.isArray(urls) || urls.length > 8) throw new Error(`RPC_FALLBACK_URLS_JSON entry ${chain} must be an array of at most eight URLs for a configured chain.`);
    for (const rawUrl of urls) {
      let parsed;
      try { parsed = new URL(rawUrl); } catch { throw new Error(`RPC_FALLBACK_URLS_JSON entry ${chain} contains an invalid URL.`); }
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname))) {
        throw new Error(`RPC fallback URL for ${chain} must use HTTPS (HTTP is allowed only for localhost development).`);
      }
    }
  }

  // Eligibility data (Merkle proofs, mint signatures, SeaDrop server signatures) comes ONLY from
  // operator-configured providers. Users reference a provider by id; they never supply URLs or paths.
  // SEADROP_SIGNATURE_PROVIDERS_JSON is the legacy name: its entries default to kind "seadrop-signed".
  const legacyProviders = jsonObject('SEADROP_SIGNATURE_PROVIDERS_JSON');
  const configuredProviders = jsonObject('ELIGIBILITY_PROVIDERS_JSON');
  const eligibilityProviders = {};
  for (const [id, provider] of [...Object.entries(legacyProviders).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? { kind: 'seadrop-signed', ...v } : v]), ...Object.entries(configuredProviders)]) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !provider || typeof provider !== 'object' || Array.isArray(provider)) {
      throw new Error(`Eligibility provider configuration contains an invalid provider id or value: ${id}`);
    }
    if (eligibilityProviders[id]) throw new Error(`Eligibility provider id ${id} is configured twice.`);
    if (!PROVIDER_KINDS.has(provider.kind)) throw new Error(`Eligibility provider ${id} kind must be merkle, signature, or seadrop-signed.`);
    if (typeof provider.url !== 'string' || !provider.url) throw new Error(`Eligibility provider ${id} requires a URL.`);
    assertProviderUrl(provider.url, `Eligibility provider ${id}`, isProduction);
    if (provider.method !== undefined && !['GET', 'POST'].includes(String(provider.method).toUpperCase())) throw new Error(`Eligibility provider ${id} method must be GET or POST.`);
    if (provider.headers !== undefined && (!provider.headers || typeof provider.headers !== 'object' || Array.isArray(provider.headers)
      || Object.values(provider.headers).some((v) => typeof v !== 'string'))) throw new Error(`Eligibility provider ${id} headers must be an object of strings.`);
    if (provider.chain !== undefined && (typeof provider.chain !== 'string' || !knownChains.has(provider.chain))) throw new Error(`Eligibility provider ${id} chain must be a configured chain key.`);
    if (provider.contract !== undefined && typeof provider.contract !== 'string' && !Array.isArray(provider.contract)) throw new Error(`Eligibility provider ${id} contract must be a string or array.`);
    eligibilityProviders[id] = { ...provider, method: String(provider.method || 'GET').toUpperCase() };
  }

  // Per-chain priority fee (tip) in gwei, e.g. {"base":"0.05"}. Overrides the chain default:
  // 0 on first-come-first-served chains (Robinhood), the RPC's suggestion elsewhere.
  const priorityFeeGwei = jsonObject('PRIORITY_FEE_GWEI_JSON');
  for (const [chain, gwei] of Object.entries(priorityFeeGwei)) {
    if (!knownChains.has(chain)) throw new Error(`PRIORITY_FEE_GWEI_JSON entry ${chain} is not a configured chain.`);
    if (typeof gwei !== 'string' && typeof gwei !== 'number') throw new Error(`PRIORITY_FEE_GWEI_JSON entry ${chain} must be a decimal gwei amount.`);
    if (!/^\d{1,6}(\.\d{1,9})?$/.test(String(gwei))) throw new Error(`PRIORITY_FEE_GWEI_JSON entry ${chain} must be a non-negative gwei amount with at most 9 decimals.`);
  }

  const allowedChains = (env.AUTOMATION_ALLOWED_CHAINS || [...knownChains].join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const chain of allowedChains) if (!knownChains.has(chain)) throw new Error(`AUTOMATION_ALLOWED_CHAINS contains an unknown chain: ${chain}`);

  // Per-chain gas caps, e.g. {"arbitrum":{"base":800000,"perToken":120000}}. Orbit/Arbitrum estimates
  // include parent-chain data cost, so they can legitimately exceed the global GAS_CAP_BASE.
  const gasCapByChain = jsonObject('GAS_CAP_JSON');
  for (const [chain, caps] of Object.entries(gasCapByChain)) {
    if (!knownChains.has(chain)) throw new Error(`GAS_CAP_JSON entry ${chain} is not a configured chain.`);
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) throw new Error(`GAS_CAP_JSON entry ${chain} must be an object with base and/or perToken.`);
    for (const [k, v] of Object.entries(caps)) {
      if (!['base', 'perToken'].includes(k) || !Number.isInteger(v) || v < 0 || v > 30_000_000) throw new Error(`GAS_CAP_JSON entry ${chain}.${k} must be base or perToken with an integer gas value.`);
    }
  }

  if (env.ERC1271_CHAIN && !knownChains.has(env.ERC1271_CHAIN)) throw new Error(`ERC1271_CHAIN must be a configured chain key (${[...knownChains].join(', ')}).`);

  const clientIpHeader = String(env.CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (clientIpHeader && !CLIENT_IP_HEADERS.has(clientIpHeader)) throw new Error(`CLIENT_IP_HEADER must be one of: ${[...CLIENT_IP_HEADERS].join(', ')}.`);

  // Removed settings. Testnets and the local node are gone; every configured chain is a mainnet.
  const warnings = [];
  for (const legacy of ['ENABLE_TESTNETS', 'ENABLE_LOCALNET', 'SEPOLIA_RPC_URL', 'BASE_SEPOLIA_RPC_URL', 'ROBINHOOD_TESTNET_RPC_URL', 'LOCAL_RPC_URL']) {
    if (env[legacy] !== undefined && env[legacy] !== '' && env[legacy] !== 'false') warnings.push(`${legacy} is no longer used: MintPilot runs on mainnets only. Remove it from the environment.`);
  }
  // AUTOMATION_MAINNET_ENABLED used to gate mainnet signing separately from testnets. With no testnets,
  // AUTOMATION_ENABLED + AUTOMATION_DRY_RUN are the switches. An explicit "false" that would now be
  // ignored while live signing is on is refused, so removing testnets can never silently enable signing.
  if (env.AUTOMATION_MAINNET_ENABLED !== undefined && env.AUTOMATION_MAINNET_ENABLED !== '') {
    if (env.AUTOMATION_MAINNET_ENABLED === 'false' && bool('AUTOMATION_ENABLED', false) && !bool('AUTOMATION_DRY_RUN', true)) {
      throw new Error('AUTOMATION_MAINNET_ENABLED=false would have blocked live signing, but that setting was removed (mainnets only). Remove it and use AUTOMATION_DRY_RUN=true or AUTOMATION_ENABLED=false to keep signing off.');
    }
    warnings.push('AUTOMATION_MAINNET_ENABLED is no longer used (mainnets only): AUTOMATION_ENABLED and AUTOMATION_DRY_RUN control signing. Remove it.');
  }

  // TRUST_PROXY_HOPS = number of reverse proxies in front of the web server (Railway: 1).
  // Legacy TRUST_PROXY=true maps to one hop.
  const trustProxyHops = env.TRUST_PROXY_HOPS !== undefined && env.TRUST_PROXY_HOPS !== ''
    ? int('TRUST_PROXY_HOPS', 0, { min: 0, max: 5 })
    : (bool('TRUST_PROXY', false) ? 1 : 0);

  const cfg = {
    env: env.NODE_ENV || 'development',
    isProduction,
    botToken: env.TELEGRAM_BOT_TOKEN || '',
    adminIds: (env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    publicUrl: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    openSeaApiKey: String(env.OPENSEA_API_KEY || '').trim(),
    port: int('PORT', 3000, { max: 65535 }),
    trustProxyHops,
    dbPath: env.DATABASE_PATH || 'data/bot.sqlite',
    eligibilityFile: env.ELIGIBILITY_FILE || 'data/eligible-addresses.json',
    eligibilityProviders,
    erc1271Chain: env.ERC1271_CHAIN || 'base',
    rpcUrls: Object.fromEntries([...knownChains].map((key) => [key, env[rpcEnvName(key)]])),
    rpcFallbackUrls,
    rpc: {
      rateLimitPerSecond: int('RPC_RATE_LIMIT_PER_SECOND', 10, { min: 1, max: 1000 }),
      rateLimitBurst: int('RPC_RATE_LIMIT_BURST', 5, { min: 1, max: 1000 }),
      failureCooldownMs: int('RPC_FAILURE_COOLDOWN_MS', 5000, { min: 500, max: 300000 }),
      // Hard per-request timeout. ethers' default is 5 minutes with up to 12 hidden 429 retries; MintPilot
      // fails fast instead and fails over to the next endpoint itself.
      timeoutMs: int('RPC_TIMEOUT_MS', 8000, { min: 1000, max: 60000 })
    },
    // Optional Etherscan V2 key: last-resort verified-ABI source (free tier covers Ethereum and Arbitrum
    // among the configured chains; Base and OP need a paid plan). Blockscout and Sourcify need no key.
    etherscanApiKey: String(env.ETHERSCAN_API_KEY || '').trim(),
    clientIpHeader,
    // Bearer token for GET /metrics. Unset = metrics endpoint disabled.
    metricsToken: String(env.METRICS_TOKEN || '').trim(),
    bot: {
      // Updates from different chats run in parallel up to this limit; one chat is always handled in order.
      maxConcurrentUpdates: int('BOT_MAX_CONCURRENT_UPDATES', 32, { min: 1, max: 512 }),
      // Per-user command flood limit.
      userMessagesPerWindow: int('BOT_USER_MESSAGES_PER_WINDOW', 20, { min: 1, max: 1000 }),
      userWindowSec: int('BOT_USER_WINDOW_SECONDS', 30, { min: 1, max: 3600 })
    },
    telegram: {
      // Outbound pacing below Telegram's limits (about 30 messages/s overall, about 1/s per chat).
      globalPerSecond: int('TELEGRAM_GLOBAL_PER_SECOND', 25, { min: 1, max: 30 }),
      perChatIntervalMs: int('TELEGRAM_PER_CHAT_INTERVAL_MS', 1000, { min: 0, max: 10000 }),
      perChatBurst: int('TELEGRAM_PER_CHAT_BURST', 3, { min: 1, max: 20 })
    },
    // Graceful shutdown: how long to wait for in-flight updates, launch sessions and the worker tick.
    shutdownDrainSec: int('SHUTDOWN_DRAIN_SECONDS', 20, { min: 1, max: 300 }),
    // Parallel receipt lookups per worker tick.
    trackingConcurrency: int('TRACKING_CONCURRENCY', 8, { min: 1, max: 64 }),
    warnings,
    plans: {
      free: {
        activeSchedules: int('FREE_ACTIVE_SCHEDULES', 3),
        wallets: int('FREE_WALLETS', 1),
        pendingTxs: int('FREE_PENDING_TXS', 5),
        preReminders: false
      },
      premium: {
        activeSchedules: int('PREMIUM_ACTIVE_SCHEDULES', 30),
        wallets: int('PREMIUM_WALLETS', 5),
        pendingTxs: int('PREMIUM_PENDING_TXS', 50),
        preReminders: true
      }
    },
    premium: { priceStars: int('PREMIUM_PRICE_STARS', 250), days: int('PREMIUM_DAYS', 30) },
    referral: {
      referrerDays: int('REFERRAL_REFERRER_DAYS', 3),
      refereeDays: int('REFERRAL_REFEREE_DAYS', 1),
      maxRewards: int('REFERRAL_MAX_REWARDS', 20)
    },
    maxMintValueEth: env.MAX_MINT_VALUE_ETH || '1',
    maxMintQuantity: int('MAX_MINT_QUANTITY', 10, { min: 1, max: 100 }),
    // Background loop cadence. Launches do not depend on it: the launch engine arms each mint
    // LAUNCH_ARM_SECONDS early and fires it from its own millisecond timer.
    workerTickMs: int('WORKER_TICK_MS', 5000, { min: 1000, max: 60000 }),
    launch: {
      // A revert from an unknown contract counts as "not open yet" for this long after the opening time.
      graceSec: int('LAUNCH_GRACE_SECONDS', 120, { min: 0, max: 3600 }),
      // A schedule with no end time stops retrying this long after its start/opening time.
      maxWaitSec: int('LAUNCH_MAX_WAIT_SECONDS', 21600, { min: 300, max: 7 * 24 * 3600 }),
      // Launch engine (docs/adr/0005-launch-engine.md). false = v2.1 behaviour (tick-driven only).
      engine: bool('LAUNCH_ENGINE', true),
      // Prepare, check and pre-sign this many seconds before the opening; only the broadcast runs at T.
      armSec: int('LAUNCH_ARM_SECONDS', 60, { min: 5, max: 600 }),
      // Broadcast at T + offset (local clock, NTP-synced). Negative fires early (risk: a cheap revert, then retry).
      fireOffsetMs: int('LAUNCH_FIRE_OFFSET_MS', 50, { min: -2000, max: 10000 }),
      // Fast loop window after T: timing reverts and transient errors retry within milliseconds.
      hotWindowSec: int('LAUNCH_HOT_WINDOW_SECONDS', 120, { min: 10, max: 3600 }),
      retryIntervalMs: int('LAUNCH_RETRY_INTERVAL_MS', 250, { min: 50, max: 10000 }),
      receiptPollMs: int('LAUNCH_RECEIPT_POLL_MS', 200, { min: 50, max: 5000 }),
      receiptWatchSec: int('LAUNCH_RECEIPT_WATCH_SECONDS', 60, { min: 5, max: 900 }),
      // A mint that reverts on-chain is re-signed (fresh nonce) at most this many times per schedule.
      maxChainRetries: int('LAUNCH_MAX_CHAIN_RETRIES', 3, { min: 0, max: 10 }),
      maxSessions: int('LAUNCH_MAX_SESSIONS', 100, { min: 1, max: 1000 }),
      // Pre-signed transactions carry headroom over the base fee seen at arming time (EIP-1559 charges the
      // actual base fee, so headroom only raises the balance the wallet must hold, not the cost).
      armedFeeMultiplierBps: int('LAUNCH_ARMED_FEE_MULTIPLIER_BPS', 30000, { min: 10000, max: 100000 })
    },
    fees: {
      baseMultiplierBps: int('FEE_BASE_MULTIPLIER_BPS', 20000, { min: 10000, max: 100000 }),
      priorityFeeGwei
    },
    gas: {
      // gasLimit = estimate × multiplier, refused when the estimate exceeds base + perToken × (quantity − 1).
      capBase: int('GAS_CAP_BASE', 300000, { min: 21000, max: 30_000_000 }),
      capPerToken: int('GAS_CAP_PER_TOKEN', 100000, { min: 0, max: 5_000_000 }),
      byChain: gasCapByChain,
      estimateMultiplierBps: int('GAS_ESTIMATE_MULTIPLIER_BPS', 12500, { min: 10000, max: 30000 })
    },
    automation: {
      enabled: bool('AUTOMATION_ENABLED', false),
      dryRun: bool('AUTOMATION_DRY_RUN', true),
      allowedChains,
      maxValueEth: env.AUTOMATION_MAX_VALUE_ETH || '0.2',
      maxConcurrentWallets: int('AUTOMATION_MAX_CONCURRENT_WALLETS', 4, { min: 1, max: 16 }),
      walletLockTtlSec: int('AUTOMATION_WALLET_LOCK_TTL_SECONDS', 120, { min: 30, max: 900 }),
      encryptionKey: env.AUTOMATION_MASTER_KEY || ''
    }
  };
  // The tick must reach every schedule inside its arming window, with a tick to spare.
  if (cfg.launch.armSec * 1000 < cfg.workerTickMs * 2) throw new Error('LAUNCH_ARM_SECONDS must be at least two WORKER_TICK_MS intervals.');
  return cfg;
}

module.exports = { loadConfig, PROVIDER_KINDS, CLIENT_IP_HEADERS };
