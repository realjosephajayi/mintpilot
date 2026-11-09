'use strict';

const { createHash } = require('node:crypto');
const { isAddress } = require('ethers');
const { openSeaChainFor } = require('../chains');
const { MintSpecError } = require('./errors');

const API_BASE = 'https://api.opensea.io/api/v2';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/i;
const cooldownByKey = new Map();
const queuesByKey = new Map();

class OpenSeaApiError extends Error {
  constructor(message, { status = null, retryable = false, retryAfterSec = null, apiCode = null } = {}) {
    super(message);
    this.name = 'OpenSeaApiError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSec = retryAfterSec;
    // OpenSea error bodies carry a stable `code` (e.g. NOT_MINTING, MINTER_NOT_ELIGIBLE); branch on it, not on text.
    this.apiCode = apiCode;
  }
}

function validateSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new MintSpecError('OpenSea collection slug must contain only letters, numbers, and hyphens.');
  return slug;
}

function keyId(key) { return createHash('sha256').update(String(key)).digest('hex'); }

function retryAfterSeconds(response, nowMs = Date.now()) {
  const raw = response?.headers?.get?.('retry-after');
  if (raw != null && /^\d+(?:\.\d+)?$/.test(raw.trim())) return Math.max(1, Math.ceil(Number(raw)));
  if (raw) {
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - nowMs) / 1000));
  }
  const reset = Number(response?.headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - nowMs / 1000));
  return null;
}

function safeApiMessage(body, key) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const text = errors.filter((x) => typeof x === 'string').join('; ').slice(0, 300);
  if (!text) return '';
  return text.replaceAll(key, '[redacted]').replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]').replace(/[\r\n\u0000-\u001f]+/g, ' ');
}

async function serializeForKey(id, action) {
  const previous = queuesByKey.get(id) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  queuesByKey.set(id, current);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (queuesByKey.get(id) === current) queuesByKey.delete(id);
  }
}

async function requestJson(path, { cfg, fetchImpl = globalThis.fetch, method = 'GET', body, timeoutMs = 6000 } = {}) {
  const apiKey = String(cfg?.openSeaApiKey || '').trim();
  if (!apiKey) throw new OpenSeaApiError('OpenSea REST is not configured; set OPENSEA_API_KEY on the server.', { retryable: false });
  if (typeof fetchImpl !== 'function') throw new OpenSeaApiError('OpenSea REST HTTP client is unavailable.', { retryable: true });

  const id = keyId(apiKey);
  return serializeForKey(id, async () => {
    const blockedUntil = cooldownByKey.get(id) || 0;
    if (blockedUntil > Date.now()) {
      const retryAfterSec = Math.ceil((blockedUntil - Date.now()) / 1000);
      throw new OpenSeaApiError(`OpenSea rate limit or provider cooldown is active; retry in ${retryAfterSec} seconds.`, { status: 429, retryable: true, retryAfterSec });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(`${API_BASE}${path}`, {
          method,
          redirect: 'error',
          signal: controller.signal,
          headers: { accept: 'application/json', 'x-api-key': apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      } catch (e) {
        const aborted = e?.name === 'AbortError';
        cooldownByKey.set(id, Date.now() + 2000);
        throw new OpenSeaApiError(aborted ? 'OpenSea REST request timed out.' : 'OpenSea REST network request failed.', { retryable: true, retryAfterSec: 2 });
      }

      const remaining = response.headers?.get?.('x-ratelimit-remaining');
      const reset = Number(response.headers?.get?.('x-ratelimit-reset'));
      const headerRetryAfter = retryAfterSeconds(response);
      if (remaining === '0' && Number.isFinite(reset) && reset * 1000 > Date.now()) cooldownByKey.set(id, reset * 1000);

      let payload = null;
      try { payload = await response.json(); } catch { /* the status below provides the bounded error */ }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status === 503 || response.status >= 500;
        const retryAfterSec = headerRetryAfter || (retryable ? 2 : null);
        if (retryable) cooldownByKey.set(id, Math.max(cooldownByKey.get(id) || 0, Date.now() + (retryAfterSec || 2) * 1000));
        const detail = safeApiMessage(payload, apiKey);
        const labels = {
          400: 'invalid OpenSea mint request', 401: 'OpenSea API key is invalid or expired',
          403: 'OpenSea API key is not authorized', 404: 'OpenSea drop was not found',
          409: 'OpenSea drop is not currently active', 422: 'OpenSea mint precondition failed'
        };
        const message = `OpenSea REST ${labels[response.status] || `request failed (HTTP ${response.status})`}${detail ? `: ${detail}` : ''}.`;
        const apiCode = typeof payload?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(payload.code) ? payload.code : null;
        throw new OpenSeaApiError(message, { status: response.status, retryable, retryAfterSec, apiCode });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new OpenSeaApiError('OpenSea REST returned an invalid JSON response.', { retryable: true });
      return payload;
    } finally {
      clearTimeout(timer);
    }
  });
}

async function getOpenSeaDrop(slug, options = {}) {
  const safeSlug = validateSlug(slug);
  const drop = await requestJson(`/drops/${encodeURIComponent(safeSlug)}`, options);
  if (typeof drop.collection_slug !== 'string' || typeof drop.chain !== 'string' || !isAddress(drop.contract_address)
    || typeof drop.drop_type !== 'string' || !Number.isInteger(drop.fee_bps) || drop.fee_bps < 0 || drop.fee_bps > 10000) {
    throw new OpenSeaApiError('OpenSea REST drop metadata is incomplete.', { retryable: true });
  }
  return drop;
}

/** Search OpenSea collections on one selected network; only collection results are returned. */
async function searchOpenSeaCollections(query, { chain, limit = 8, ...options } = {}) {
  const text = String(query || '').trim();
  if (text.length < 2 || text.length > 100) throw new MintSpecError('Search with 2 to 100 characters.');
  const openSeaChain = openSeaChainFor(chain);
  if (!openSeaChain) throw new MintSpecError(`OpenSea collection search is not available on ${chain}.`);
  const count = Math.max(1, Math.min(20, Number(limit) || 8));
  const params = new URLSearchParams({ query: text, chains: openSeaChain, asset_types: 'collection', limit: String(count) });
  const payload = await requestJson(`/search?${params.toString()}`, options);
  if (!Array.isArray(payload.results)) throw new OpenSeaApiError('OpenSea search returned an invalid response.', { retryable: true });
  return payload.results
    .filter((item) => item?.type === 'collection' && item.collection && SLUG_RE.test(item.collection.collection))
    .map((item) => ({
      slug: item.collection.collection,
      name: String(item.collection.name || item.collection.collection).slice(0, 120),
      disabled: Boolean(item.collection.is_disabled),
      url: typeof item.collection.opensea_url === 'string' ? item.collection.opensea_url : null
    }))
    .filter((item) => !item.disabled)
    .slice(0, count);
}

/** Resolve a contract address to its OpenSea collection slug on the selected chain. */
async function getOpenSeaCollectionByContract(address, { chain, ...options } = {}) {
  if (!isAddress(address)) throw new MintSpecError('Enter a valid NFT contract address.');
  const openSeaChain = openSeaChainFor(chain);
  if (!openSeaChain) throw new MintSpecError(`OpenSea collection lookup is not available on ${chain}.`);
  const result = await requestJson(`/chain/${encodeURIComponent(openSeaChain)}/contract/${encodeURIComponent(address)}`, options);
  if (typeof result.collection !== 'string' || !SLUG_RE.test(result.collection)) {
    throw new OpenSeaApiError('OpenSea could not match that contract to a collection.', { retryable: false });
  }
  if (result.chain && String(result.chain).toLowerCase() !== openSeaChain.toLowerCase()) {
    throw new OpenSeaApiError('OpenSea returned a contract on a different network.', { retryable: false });
  }
  if (result.address && String(result.address).toLowerCase() !== String(address).toLowerCase()) {
    throw new OpenSeaApiError('OpenSea returned a different contract address.', { retryable: false });
  }
  return { slug: result.collection, name: String(result.name || result.collection).slice(0, 120) };
}

function assertDropMatchesSchedule(drop, schedule, expectedSlug = null) {
  if (drop.drop_type !== 'seadrop_v1_erc721') throw new MintSpecError('OpenSea REST mint routing supports ERC-721 SeaDrop V1 drops only.');
  const requestedSlug = expectedSlug || schedule.expectedOpenSeaSlug || schedule.mintSpec?.slug || null;
  if (requestedSlug && String(drop.collection_slug).toLowerCase() !== String(requestedSlug).toLowerCase()) throw new MintSpecError('OpenSea drop slug does not match the selected collection.');
  const expectedChain = openSeaChainFor(schedule.chain);
  if (!expectedChain) throw new MintSpecError(`OpenSea REST minting is not supported on ${schedule.chain}.`);
  if (String(drop.chain).toLowerCase() !== expectedChain) throw new MintSpecError(`OpenSea drop is on ${drop.chain}, not the selected ${schedule.chain} network.`);
  if (String(drop.contract_address).toLowerCase() !== String(schedule.contract).toLowerCase()) throw new MintSpecError('OpenSea drop contract does not match the selected NFT contract.');
  return drop;
}

async function buildOpenSeaMintTransaction(slug, { cfg, fetchImpl, minter, quantity } = {}) {
  const safeSlug = validateSlug(slug);
  if (!isAddress(minter)) throw new MintSpecError('OpenSea mint wallet must be a valid EVM address.');
  const n = Number(quantity);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new MintSpecError('OpenSea mint quantity must be between 1 and 100.');
  return requestJson(`/drops/${encodeURIComponent(safeSlug)}/mint`, { cfg, fetchImpl, method: 'POST', body: { minter, quantity: n } });
}

module.exports = { API_BASE, OpenSeaApiError, validateSlug, getOpenSeaDrop, searchOpenSeaCollections, getOpenSeaCollectionByContract, assertDropMatchesSchedule, buildOpenSeaMintTransaction, requestJson, retryAfterSeconds };
