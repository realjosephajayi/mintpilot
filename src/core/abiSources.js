'use strict';
// Verified-ABI lookup for contract discovery, mainnet-wide.
//   1. The chain's Blockscout instance (chain.abiApi): free, no key, also serves Sourcify-verified code.
//   2. Sourcify APIv2: free, no key, chain-id addressed.
//   3. Etherscan V2 (only when ETHERSCAN_API_KEY is set): one key, chainid parameter.
// Every request is bounded (timeout, size, no redirects). Results are cached per chain+address and
// concurrent lookups for the same contract share one request, so a crowd scheduling the same drop
// costs one explorer call instead of one per user.
// An ABI only ever narrows what MintPilot offers (which supported method exists); it never adds a
// calldata shape that is not implemented and tested in mintAdapters.js.

const MAX_BYTES = 2 * 1024 * 1024;
const TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 1000;

async function boundedJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const length = Number(res.headers?.get?.('content-length') || 0);
    if (length > MAX_BYTES) return null;
    const text = await res.text();
    if (text.length > MAX_BYTES) return null;
    return JSON.parse(text);
  } catch { return null; } finally { clearTimeout(timer); }
}

const asAbi = (value) => {
  let abi = value;
  if (typeof abi === 'string') { try { abi = JSON.parse(abi); } catch { return null; } }
  return Array.isArray(abi) && abi.length ? abi : null;
};

function createAbiSources({ fetchImpl = fetch, etherscanApiKey = '', timeoutMs = 2500, now = Date.now } = {}) {
  const cache = new Map();
  const inflight = new Map();

  const sources = [
    {
      name: 'blockscout',
      url: (chain, address) => chain.abiApi ? `${chain.abiApi.replace(/\/$/, '')}/api/v2/smart-contracts/${address}` : null,
      pick: (body) => asAbi(body?.abi)
    },
    {
      name: 'sourcify',
      url: (chain, address) => `https://sourcify.dev/server/v2/contract/${chain.chainId}/${address}?fields=abi`,
      pick: (body) => asAbi(body?.abi)
    },
    {
      name: 'etherscan',
      url: (chain, address) => etherscanApiKey
        ? `https://api.etherscan.io/v2/api?chainid=${chain.chainId}&module=contract&action=getabi&address=${address}&apikey=${encodeURIComponent(etherscanApiKey)}`
        : null,
      pick: (body) => (body?.status === '1' ? asAbi(body.result) : null)
    }
  ];

  async function lookup(chain, address) {
    for (const source of sources) {
      const url = source.url(chain, address);
      if (!url) continue;
      const abi = source.pick(await boundedJson(fetchImpl, url, timeoutMs));
      if (abi) return { abi, source: source.name };
    }
    return null;
  }

  return {
    /** { abi, source } or null. Never throws. */
    async verifiedAbi(chain, address) {
      if (!chain || !address) return null;
      const key = `${chain.chainId}:${String(address).toLowerCase()}`;
      const hit = cache.get(key);
      if (hit && hit.expires > now()) return hit.value;
      if (inflight.has(key)) return inflight.get(key);
      const p = lookup(chain, address).then((value) => {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(key, { value, expires: now() + (value ? TTL_MS : NEGATIVE_TTL_MS) });
        return value;
      }).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
    size: () => cache.size
  };
}

module.exports = { createAbiSources };
