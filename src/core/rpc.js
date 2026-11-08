'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { JsonRpcProvider, FetchRequest, Network, Interface, Transaction, id: keccakId, zeroPadValue, getAddress } = require('ethers');
const { discoverContract } = require('./contractDiscovery');
const { createAbiSources } = require('./abiSources');

// Priority lanes for the per-endpoint read limiter. The lane travels with the async call chain, so
// callers mark a whole operation once: the launch engine runs in 'high', receipt polling in 'low',
// and everything else (bot commands, the worker's due mints) defaults to 'normal'. When an endpoint's
// token bucket is empty, waiting 'high' requests are served first, then 'normal', then 'low'.
const PRIORITIES = ['high', 'normal', 'low'];
const lane = new AsyncLocalStorage();
/** Run `fn` with every RPC read inside it queued at `priority` ('high' | 'normal' | 'low'). */
const withRpcPriority = (priority, fn) => lane.run(PRIORITIES.includes(priority) ? priority : 'normal', fn);
const currentPriority = () => lane.getStore() || 'normal';

const TRANSFER_TOPIC = keccakId('Transfer(address,address,uint256)');
const TRANSFER_SINGLE_TOPIC = keccakId('TransferSingle(address,address,address,uint256,uint256)');
const TRANSFER_BATCH_TOPIC = keccakId('TransferBatch(address,address,address,uint256[],uint256[])');
const ERC1155_EVENTS = new Interface([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
]);
const TOKEN_BALANCE_INTERFACE = new Interface([
  'function balanceOf(address owner) view returns(uint256)',
  'function balanceOf(address account,uint256 id) view returns(uint256)'
]);
const SEADROP_INTERFACE = new Interface(['function getAllowedSeaDrop() view returns(address[])']);
const MARKER = Symbol('mintpilotRpcSendWrapped');

/**
 * Token ids received by any of `wallets` in this receipt.
 * - ERC-721 Transfer: ERC-20 Transfer has the same topic0 but only 3 topics, so 4 topics selects ERC-721.
 * - ERC-1155 TransferSingle / TransferBatch: the recipient is topic 3; ids and amounts are in data.
 *   Amounts above one are reported as "<id> ×<amount>".
 */
function parseReceivedTokenIds(logs, wallets) {
  const targets = new Set(wallets.map((w) => zeroPadValue(getAddress(w), 32).toLowerCase()));
  const ids = [];
  const label = (id, amount) => (amount === 1n ? id.toString() : `${id.toString()} ×${amount.toString()}`);
  for (const log of logs) {
    const topic0 = log.topics[0];
    if (topic0 === TRANSFER_TOPIC && log.topics.length === 4 && targets.has(log.topics[2].toLowerCase())) {
      ids.push(BigInt(log.topics[3]).toString());
    } else if ((topic0 === TRANSFER_SINGLE_TOPIC || topic0 === TRANSFER_BATCH_TOPIC) && log.topics.length === 4 && targets.has(log.topics[3].toLowerCase())) {
      let parsed;
      try { parsed = ERC1155_EVENTS.parseLog({ topics: log.topics, data: log.data }); } catch { continue; }
      if (!parsed) continue;
      // Positional access: `values` would resolve to Array.prototype.values on an ethers Result.
      const [, , , idOrIds, valueOrValues] = parsed.args;
      if (parsed.name === 'TransferSingle') ids.push(label(idOrIds, valueOrValues));
      else Array.from(idOrIds).forEach((id, i) => ids.push(label(id, valueOrValues[i])));
    }
  }
  return ids;
}

function createRateLimiter({ ratePerSecond = 10, burst = 5, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const rate = Math.max(1, Number(ratePerSecond) || 10);
  const capacity = Math.max(1, Number(burst) || 5);
  let tokens = capacity;
  let lastRefill = now();
  const queues = { high: [], normal: [], low: [] };
  let pumping = false;
  const waiting = () => queues.high.length + queues.normal.length + queues.low.length;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (waiting()) {
        const current = now();
        tokens = Math.min(capacity, tokens + ((current - lastRefill) * rate / 1000));
        lastRefill = current;
        if (tokens >= 1) {
          tokens -= 1;
          const lane = PRIORITIES.find((p) => queues[p].length);
          queues[lane].shift()();
          continue;
        }
        await sleep(Math.max(1, Math.ceil((1 - tokens) * 1000 / rate)));
      }
    } finally { pumping = false; }
  }
  return {
    /** Resolves when a request may be sent. `priority` defaults to the caller's lane. */
    acquire(priority = currentPriority()) {
      return new Promise((resolve) => { (queues[priority] || queues.normal).push(resolve); pump(); });
    },
    pending: () => ({ high: queues.high.length, normal: queues.normal.length, low: queues.low.length })
  };
}

function errorText(error) {
  return String(error?.shortMessage || error?.message || error?.code || error || 'RPC error')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => sanitizedHost(raw))
    .replace(/((?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}

function isWrongChain(error) { return error?.code === 'RPC_WRONG_CHAIN'; }

/** Do not retry deterministic EVM reverts or unknown/write errors. */
function isRetryableRpcError(error) {
  if (isWrongChain(error)) return true; // quarantined, then proceed to a different configured endpoint
  const status = Number(error?.status || error?.statusCode || error?.response?.status || error?.info?.responseStatus);
  if (status === 429 || status >= 500) return true;
  const code = String(error?.code || error?.info?.error?.code || '').toUpperCase();
  if (['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(code)) return true;
  if (code === '-32005' || code === '-32002' || code === '429') return true;
  const message = errorText(error).toLowerCase();
  if (/rate.?limit|too many requests|http 429|status.?429|gateway timeout|service unavailable|connection reset|socket hang up|timed? ?out|fetch failed|network error|econnreset|econnrefused|etimedout|ehostunreach|eai_again/.test(message)) return true;
  return false;
}

/** The node already holds this exact transaction: for a broadcast that is acceptance, not failure. */
function isAlreadyKnown(error) {
  return /already known|known transaction|already imported|alreadyknown|tx already exists|transaction already exists/i.test(errorText(error));
}

/** Errors that prove a node REJECTED a signed transaction (see outcomes.classifyBroadcastError). */
function isDefinitiveRejection(error) {
  if (['INSUFFICIENT_FUNDS', 'NONCE_EXPIRED', 'REPLACEMENT_UNDERPRICED'].includes(error?.code)) return true;
  return /max fee per gas less than block base fee|fee cap less than block base fee|feecap .* below|transaction underpriced|intrinsic gas too low|gas limit reached|exceeds block gas limit/i.test(errorText(error));
}

function sanitizedHost(url) {
  try { return new URL(url).host; } catch { return 'configured-endpoint'; }
}

/**
 * RPC access layer with independent endpoint health, expected-chain verification,
 * per-endpoint send throttling, and failover only for idempotent reads. The raw
 * provider returned by provider() is retained for ethers Wallet compatibility;
 * signed transaction broadcasts are never automatically replayed by this layer.
 */
function createRpc(chains, {
  providerFactory,
  log = console,
  rateLimitPerSecond = 10,
  rateLimitBurst = 5,
  failureCooldownMs = 5000,
  timeoutMs = 8000,
  etherscanApiKey = '',
  abiSources = null,
  now = Date.now,
  sleep
} = {}) {
  const pools = new Map();
  const providerEntries = new WeakMap();
  const abi = abiSources || createAbiSources({ etherscanApiKey });
  // Every request has a hard timeout and NO hidden retries: ethers' FetchRequest defaults are a
  // 5-minute timeout and up to 12 silent 429 retries, which made one slow endpoint stall a user for
  // minutes. A 429/timeout now surfaces at once and this layer fails over to the next endpoint.
  const connection = (url) => {
    const request = new FetchRequest(url);
    request.timeout = timeoutMs;
    request.setThrottleParams({ maxAttempts: 1 });
    return request;
  };
  // Reads: short batch stall (ethers' default holds every request 10 ms to batch it).
  const make = providerFactory || ((c) => new JsonRpcProvider(connection(c.rpcUrl), Network.from(c.chainId), { staticNetwork: Network.from(c.chainId), batchStallTime: 1 }));
  // Broadcasts: a separate connection that never batches, so a signed mint is never queued behind
  // (or answered after) slow reads. Not rate limited: a launch broadcast must not wait for read tokens.
  const makeSender = providerFactory
    ? ((c, url, index, readProvider) => readProvider)
    : ((c) => new JsonRpcProvider(connection(c.rpcUrl), Network.from(c.chainId), { staticNetwork: Network.from(c.chainId), batchMaxCount: 1 }));

  function endpointPool(key) {
    const chain = chains[key];
    if (!chain) throw new Error(`Unsupported chain: ${key}`);
    if (pools.has(key)) return pools.get(key);
    const configured = Array.isArray(chain.rpcUrls) ? chain.rpcUrls : [];
    const urls = [...new Set([...(chain.rpcUrl ? [chain.rpcUrl] : []), ...configured].filter(Boolean))];
    if (!urls.length) throw new Error(`No RPC endpoint is configured for ${key}.`);
    const pool = {
      key, chain, cursor: 0, lastSelected: null,
      endpoints: urls.map((url, index) => {
        const endpointChain = { ...chain, rpcUrl: url };
        const provider = make(endpointChain, url, index);
        const entry = {
          index, url, host: sanitizedHost(url), provider, sender: makeSender(endpointChain, url, index, provider),
          limiter: createRateLimiter({ ratePerSecond: rateLimitPerSecond, burst: rateLimitBurst, now, sleep }),
          verified: false, verifying: null, disabled: false, cooldownUntil: 0,
          failures: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null
        };
        instrument(entry);
        providerEntries.set(provider, entry);
        return entry;
      })
    };
    pools.set(key, pool);
    return pool;
  }

  function instrument(entry) {
    const p = entry.provider;
    if (!p || typeof p.send !== 'function' || p[MARKER]) return;
    const originalSend = p.send.bind(p);
    entry.unthrottledSend = originalSend; // broadcasts bypass the read limiter even on a shared provider
    try {
      p.send = async (...args) => {
        await entry.limiter.acquire();
        return originalSend(...args);
      };
      Object.defineProperty(p, MARKER, { value: true });
    } catch { /* providerFactory fakes may expose a read-only send method */ }
  }

  function markSuccess(entry) {
    entry.verified = true;
    entry.failures = 0;
    entry.cooldownUntil = 0;
    entry.lastSuccessAt = now();
    entry.lastError = null;
  }

  function markFailure(pool, entry, error) {
    const at = now();
    entry.lastFailureAt = at;
    entry.lastError = errorText(error).slice(0, 180);
    if (isWrongChain(error)) {
      entry.disabled = true;
      entry.cooldownUntil = Number.MAX_SAFE_INTEGER;
    } else {
      entry.failures += 1;
      const backoff = Math.min(Math.max(250, failureCooldownMs) * (2 ** Math.min(entry.failures - 1, 4)), 60_000);
      entry.cooldownUntil = at + backoff;
    }
    const next = pool.endpoints.find((x) => x !== entry && !x.disabled && x.cooldownUntil <= at);
    if (next && log && typeof log.warn === 'function') {
      log.warn('rpc endpoint failed; read failover may be used', {
        chain: pool.key, endpoint: entry.index, host: entry.host,
        nextEndpoint: next.index, error: entry.lastError
      });
    }
  }

  async function verify(pool, entry) {
    if (entry.disabled) throw Object.assign(new Error(`RPC endpoint ${entry.index} is quarantined for ${pool.key}.`), { code: 'RPC_WRONG_CHAIN' });
    if (entry.verified) return;
    if (entry.verifying) return entry.verifying;
    entry.verifying = (async () => {
      try {
        const hex = await entry.provider.send('eth_chainId', []);
        const actual = Number(BigInt(hex));
        if (actual !== pool.chain.chainId) {
          throw Object.assign(new Error(`RPC for ${pool.key} returned chain id ${actual}, expected ${pool.chain.chainId}.`), { code: 'RPC_WRONG_CHAIN' });
        }
        entry.verified = true;
      } finally { entry.verifying = null; }
    })();
    return entry.verifying;
  }

  function candidates(pool) {
    const at = now();
    const start = pool.cursor % pool.endpoints.length;
    const ordered = pool.endpoints.slice(start).concat(pool.endpoints.slice(0, start));
    const ready = ordered.filter((entry) => !entry.disabled && entry.cooldownUntil <= at);
    return ready;
  }

  async function provider(key) {
    const pool = endpointPool(key);
    const ready = candidates(pool);
    if (!ready.length) throw new Error(`All RPC endpoints for ${key} are unavailable or cooling down; retry later.`);
    let lastError;
    for (const entry of ready) {
      try {
        await verify(pool, entry);
        if (pool.lastSelected !== null && pool.lastSelected !== entry.index && log && typeof log.info === 'function') {
          log.info('rpc provider selected after failover', { chain: key, fromEndpoint: pool.lastSelected, toEndpoint: entry.index, host: entry.host });
        }
        pool.lastSelected = entry.index;
        pool.cursor = (entry.index + 1) % pool.endpoints.length;
        return entry.provider;
      } catch (error) {
        lastError = error;
        markFailure(pool, entry, error);
      }
    }
    throw new Error(`No verified RPC endpoint is available for ${key}: ${errorText(lastError)}`);
  }

  async function withReadProvider(key, operation) {
    const pool = endpointPool(key);
    const ready = candidates(pool);
    if (!ready.length) throw new Error(`All RPC endpoints for ${key} are unavailable or cooling down; retry later.`);
    let lastError;
    for (const entry of ready) {
      try {
        await verify(pool, entry);
        const result = await operation(entry.provider);
        markSuccess(entry);
        pool.lastSelected = entry.index;
        pool.cursor = (entry.index + 1) % pool.endpoints.length;
        return result;
      } catch (error) {
        lastError = error;
        if (!isRetryableRpcError(error)) throw error;
        markFailure(pool, entry, error);
      }
    }
    throw new Error(`All RPC endpoints for ${key} failed for a read request: ${errorText(lastError)}`);
  }

  function call(key, method, args) {
    return withReadProvider(key, (p) => {
      if (typeof p[method] !== 'function') throw new Error(`RPC provider does not implement ${method}.`);
      return p[method](...args);
    });
  }

  return {
    provider,
    async getBalance(key, address) { return (await call(key, 'getBalance', [address])).toString(); },
    async estimateGas(key, transaction) { return call(key, 'estimateGas', [transaction]); },
    async getFeeData(key) { return call(key, 'getFeeData', []); },
    async getErc721Balance(key, contract, address) {
      const data = '0x70a08231' + String(address).slice(2).padStart(64, '0');
      return BigInt(await call(key, 'call', [{ to: contract, data }])).toString();
    },
    async getTokenBalance(key, standard, contract, address, tokenId = null) {
      const kind = String(standard).toLowerCase();
      let data;
      if (kind === 'erc1155') {
        if (tokenId == null) throw new Error('ERC-1155 token gate requires a token ID.');
        data = TOKEN_BALANCE_INTERFACE.encodeFunctionData('balanceOf(address,uint256)', [address, BigInt(tokenId)]);
      } else if (kind === 'erc20' || kind === 'erc721') {
        data = TOKEN_BALANCE_INTERFACE.encodeFunctionData('balanceOf(address)', [address]);
      } else throw new Error('Unsupported token gate standard.');
      return BigInt(await call(key, 'call', [{ to: contract, data }])).toString();
    },
    async hasCode(key, address) { return (await call(key, 'getCode', [address])) !== '0x'; },
    async getAllowedSeaDrop(key, contract) {
      const data = SEADROP_INTERFACE.encodeFunctionData('getAllowedSeaDrop', []);
      const result = await call(key, 'call', [{ to: contract, data }]);
      return SEADROP_INTERFACE.decodeFunctionResult('getAllowedSeaDrop', result)[0].map((x) => x.toLowerCase());
    },
    async getChainTime(key) {
      const block = await call(key, 'getBlock', ['latest']);
      if (!block || !Number.isInteger(Number(block.timestamp))) throw new Error(`Latest block timestamp unavailable for ${key}.`);
      return Number(block.timestamp);
    },
    async discover(key, address) {
      const chain = chains[key];
      if (!chain) throw new Error(`Unsupported chain: ${key}`);
      return withReadProvider(key, (p) => discoverContract(p, address, { chain, abiSources: abi }));
    },
    /** Receipt summary or null while pending. */
    async getReceipt(key, hash) {
      return withReadProvider(key, async (p) => {
        // Both requests in one batch: one round trip.
        const [r, latest] = await Promise.all([p.getTransactionReceipt(hash), p.getBlockNumber()]);
        if (!r) return null;
        return {
          status: r.status === 1 ? 'confirmed' : 'failed', blockNumber: r.blockNumber,
          confirmations: Math.max(0, Number(latest) - r.blockNumber + 1), logs: r.logs,
          gasUsed: r.gasUsed == null ? null : r.gasUsed.toString()
        };
      });
    },
    async getBlockTimestamp(key, blockNumber) {
      const block = await call(key, 'getBlock', [Number(blockNumber)]);
      return block && block.timestamp != null ? Number(block.timestamp) : null;
    },
    /**
     * Everything needed to price a transaction, in one round trip: the latest block (base fee and
     * timestamp, which doubles as the chain clock) and, when wanted, the node's suggested tip.
     */
    async getFeeInputs(key, { suggestTip = true } = {}) {
      return withReadProvider(key, async (p) => {
        const tipRequest = suggestTip && typeof p.send === 'function'
          ? p.send('eth_maxPriorityFeePerGas', []).then((x) => BigInt(x)).catch(() => null)
          : Promise.resolve(null);
        const [block, priorityFeePerGas] = await Promise.all([p.getBlock('latest'), tipRequest]);
        if (!block) throw new Error(`Latest block unavailable for ${key}.`);
        let gasPrice = null;
        if (block.baseFeePerGas == null) gasPrice = BigInt(await p.send('eth_gasPrice', []));
        return {
          baseFeePerGas: block.baseFeePerGas == null ? null : BigInt(block.baseFeePerGas),
          priorityFeePerGas, gasPrice, timestamp: Number(block.timestamp), number: Number(block.number)
        };
      });
    },
    /**
     * Send identical signed bytes to every configured endpoint at once and resolve on the FIRST
     * acceptance. Safe: identical bytes have one hash, so this can never create a second transaction.
     * "already known" counts as acceptance. When every endpoint fails, the error thrown is a definitive
     * node rejection if any endpoint gave one (insufficient funds, nonce too low, fee too low), else
     * the first ambiguous error, which the executor reconciles by hash.
     */
    async broadcast(key, raw) {
      const pool = endpointPool(key);
      const hash = Transaction.from(raw).hash;
      const started = now();
      const targets = pool.endpoints.filter((entry) => !entry.disabled);
      if (!targets.length) throw new Error(`No RPC endpoint is available to broadcast on ${key}.`);
      const sends = targets.map(async (entry) => {
        await verify(pool, entry);
        try {
          if (entry.sender === entry.provider && entry.unthrottledSend) await entry.unthrottledSend('eth_sendRawTransaction', [raw]);
          else if (typeof entry.sender.send === 'function') await entry.sender.send('eth_sendRawTransaction', [raw]);
          else await entry.sender.broadcastTransaction(raw);
          return { endpoint: entry.index, host: entry.host };
        } catch (error) {
          if (isAlreadyKnown(error)) return { endpoint: entry.index, host: entry.host, alreadyKnown: true };
          if (isRetryableRpcError(error)) markFailure(pool, entry, error);
          throw error;
        }
      });
      try {
        const winner = await Promise.any(sends);
        return { hash, endpoint: winner.endpoint, host: winner.host, alreadyKnown: Boolean(winner.alreadyKnown), ackMs: now() - started, endpoints: targets.length };
      } catch (aggregate) {
        const errors = aggregate?.errors || [aggregate];
        throw errors.find(isDefinitiveRejection) || errors[0];
      }
    },
    /**
     * Verify every endpoint and open its broadcast connection ahead of a launch, so the fire-time
     * send does not pay for a TCP/TLS handshake. Returns how many endpoints answered.
     */
    async warm(key) {
      const pool = endpointPool(key);
      const results = await Promise.allSettled(pool.endpoints.filter((e) => !e.disabled).map(async (entry) => {
        await verify(pool, entry);
        if (entry.sender !== entry.provider && typeof entry.sender.send === 'function') await entry.sender.send('eth_blockNumber', []);
        return true;
      }));
      return results.filter((r) => r.status === 'fulfilled').length;
    },
    async getTransaction(key, hash) { return call(key, 'getTransaction', [hash]); },
    async getNonce(key, address, blockTag = 'latest') { return Number(await call(key, 'getTransactionCount', [address, blockTag])); },
    /** eth_call preflight; provider transport errors are surfaced separately from contract reverts. */
    async simulate(key, { from, to, data, value, gasLimit }) {
      try {
        await call(key, 'call', [{ from, to, data, value, ...(gasLimit == null ? {} : { gasLimit: BigInt(gasLimit) }) }]);
        return { ok: true };
      } catch (e) {
        const reason = e.reason || e.shortMessage || e.message || 'reverted';
        if (isRetryableRpcError(e) || /all rpc endpoints|cooling down|no verified rpc/i.test(String(reason))) {
          return { ok: false, retryable: true, reason: `RPC unavailable: ${errorText(reason)}` };
        }
        // Revert data lets callers decode custom errors (e.g. SeaDrop NotActive) instead of guessing.
        const data = typeof e?.data === 'string' ? e.data : (typeof e?.info?.error?.data === 'string' ? e.info.error.data : null);
        return { ok: false, reason, data };
      }
    },
    /** True if the address has sent at least one tx on any configured chain (all queried in parallel). */
    async hasOnchainActivity(address) {
      const counts = await Promise.allSettled(Object.keys(chains).map((key) => call(key, 'getTransactionCount', [address])));
      return counts.some((r) => r.status === 'fulfilled' && Number(r.value) > 0);
    },
    /**
     * Native balances on many chains at once: { [chainKey]: weiString | null } (null = lookup failed).
     * Each chain fails independently and quickly (RPC_TIMEOUT_MS), so one slow network never blocks the rest.
     */
    async getBalances(address, keys = Object.keys(chains)) {
      const results = await Promise.allSettled(keys.map((key) => call(key, 'getBalance', [address])));
      return Object.fromEntries(keys.map((key, i) => [key, results[i].status === 'fulfilled' ? results[i].value.toString() : null]));
    },
    /** Raw eth_call (adapters' phase readers). */
    async ethCall(key, to, data) { return call(key, 'call', [{ to, data }]); },
    /** Mark an endpoint suspect after a direct ethers Wallet/provider operation fails; never replays the operation. */
    reportFailure(key, providerInstance, error) {
      const pool = endpointPool(key);
      const entry = providerEntries.get(providerInstance);
      if (entry && entry.provider === providerInstance && isRetryableRpcError(error)) markFailure(pool, entry, error);
    },
    health(key) {
      const pool = endpointPool(key);
      return pool.endpoints.map((entry) => ({
        endpoint: entry.index, host: entry.host, verified: entry.verified, disabled: entry.disabled,
        cooldownUntil: entry.cooldownUntil, consecutiveFailures: entry.failures,
        lastSuccessAt: entry.lastSuccessAt, lastFailureAt: entry.lastFailureAt,
        lastError: entry.lastError, queued: entry.limiter.pending()
      }));
    },
    parseReceivedTokenIds
  };
}

module.exports = { createRpc, createRateLimiter, withRpcPriority, currentPriority, isRetryableRpcError, isAlreadyKnown, isDefinitiveRejection, parseReceivedTokenIds, TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC };
