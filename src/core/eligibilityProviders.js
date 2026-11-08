'use strict';
// Resolves the live parts of a mint spec immediately before simulation and signing:
//   merkle / signature / seadrop-signed -> operator-configured HTTPS providers (by providerId)
//   opensea-drop                         -> OpenSea REST mint builder
// Users can never point the server at a URL or a file: those keys are rejected outright.
const { buildOpenSeaMintTransaction } = require('./openSeaDrops');
const { openSeaChainFor } = require('../chains');
const { MintSpecError, ProviderError } = require('./errors');

const MAX_PROVIDER_BYTES = 64 * 1024;
const PROVIDER_TIMEOUT_MS = 5000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const USER_SOURCE_KEYS = ['proofFile', 'signatureFile', 'proofUrl', 'signatureUrl'];

function object(value, label) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new MintSpecError(`${label} is not valid JSON.`); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MintSpecError(`${label} must be an object.`);
  return value;
}

async function readBodyCapped(response) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PROVIDER_BYTES) { await reader.cancel().catch(() => {}); throw new Error('too large'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_PROVIDER_BYTES) throw new Error('too large');
  return text;
}

/**
 * GET/POST an operator-configured provider and parse its JSON.
 * - HTTPS only (HTTP to localhost outside production), redirects refused, 64 KB cap, 5 s timeout.
 * - Errors are ProviderError with a message that never includes the URL, headers or body.
 */
async function readJsonUrl(url, label, fetchImpl = globalThis.fetch, query = {}, options = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new ProviderError(`${label} is misconfigured.`); }
  const devHttp = process.env.NODE_ENV !== 'production' && parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !devHttp) throw new ProviderError(`${label} is misconfigured (HTTPS required).`);
  if (typeof fetchImpl !== 'function') throw new ProviderError(`${label} is unavailable.`, { retryable: true });
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  const body = method === 'POST' ? JSON.stringify(query) : undefined;
  if (method === 'POST') headers['content-type'] = 'application/json';
  else for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) parsed.searchParams.set(key, String(value));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(parsed, { method, signal: controller.signal, headers, body, redirect: 'error' });
  } catch {
    clearTimeout(timer);
    throw new ProviderError(`${label} did not respond.`, { retryable: true });
  }
  try {
    if (!response.ok) {
      const status = Number(response.status);
      throw new ProviderError(`${label} returned HTTP ${status}.`, { status, retryable: status === 429 || status >= 500 });
    }
    let text;
    try { text = await readBodyCapped(response); } catch { throw new ProviderError(`${label} returned an oversized or unreadable response.`); }
    try { return JSON.parse(text); } catch { throw new ProviderError(`${label} returned invalid JSON.`); }
  } finally { clearTimeout(timer); }
}

function assertNoUserSources(spec) {
  const found = USER_SOURCE_KEYS.filter((key) => spec[key] !== undefined);
  if (found.length) throw new MintSpecError(`File and URL eligibility sources are not accepted (${found.join(', ')}). Use an inline proof/signature or an operator-configured providerId.`);
}

function configuredProvider(spec, schedule, cfg, kind) {
  const id = spec.providerId || spec.signatureProvider;
  if (!id) return null;
  const provider = cfg?.eligibilityProviders?.[id];
  if (!provider) throw new MintSpecError(`Eligibility provider "${id}" is not configured on this deployment.`);
  if (provider.kind !== kind) throw new MintSpecError(`Eligibility provider "${id}" serves ${provider.kind}, not ${kind}.`);
  if (provider.chain && provider.chain !== schedule.chain) throw new MintSpecError(`Eligibility provider "${id}" is not configured for ${schedule.chain}.`);
  if (provider.contract) {
    const contracts = Array.isArray(provider.contract) ? provider.contract : [provider.contract];
    if (!contracts.some((x) => String(x).toLowerCase() === String(schedule.contract).toLowerCase())) throw new MintSpecError(`Eligibility provider "${id}" is not configured for this NFT contract.`);
  }
  return { id, ...provider };
}

/** A provider answer must be about this wallet, contract, chain and quantity when it says so. */
function assertProviderBinding(data, schedule, quantity, label) {
  const address = data.address || data.wallet || data.minter || data.minterIfNotPayer;
  if (address && String(address).toLowerCase() !== String(schedule.wallet_address).toLowerCase()) throw new MintSpecError(`${label} returned data for a different wallet.`);
  for (const key of ['nftContract', 'contract']) {
    if (data[key] && String(data[key]).toLowerCase() !== String(schedule.contract).toLowerCase()) throw new MintSpecError(`${label} returned data for a different NFT contract.`);
  }
  if (data.chain && String(data.chain) !== String(schedule.chain)) throw new MintSpecError(`${label} returned data for a different chain.`);
  if (data.quantity !== undefined && Number(data.quantity) !== Number(quantity)) throw new MintSpecError(`${label} returned data for a different quantity.`);
}

async function fetchFromProvider(provider, schedule, quantity, fetchImpl) {
  const label = `Eligibility provider "${provider.id}"`;
  const query = { address: schedule.wallet_address, wallet: schedule.wallet_address, chain: schedule.chain, contract: schedule.contract, quantity };
  const payload = await readJsonUrl(provider.url, label, fetchImpl, query, { method: provider.method, headers: provider.headers });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProviderError(`${label} returned an unexpected response.`);
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : payload;
  assertProviderBinding(data, schedule, quantity, label);
  return { data, label };
}

/** Resolve dynamic eligibility data immediately before building a signing transaction. */
async function resolveMintSpec(specInput, schedule, { now = Math.floor(Date.now() / 1000), fetchImpl, cfg } = {}) {
  const spec = object(specInput, 'Mint adapter configuration');
  assertNoUserSources(spec);
  const resolved = { ...spec };
  const quantity = Number(spec.quantity ?? schedule.quantity);

  if (spec.adapter === 'opensea-drop') {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(String(spec.slug || ''))) throw new MintSpecError('OpenSea collection slug is invalid.');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity !== Number(schedule.quantity)) throw new MintSpecError('OpenSea mint quantity does not match the schedule.');
    const expectedChain = openSeaChainFor(schedule.chain);
    if (!expectedChain) throw new MintSpecError(`OpenSea REST minting is not supported on ${schedule.chain}.`);
    const payload = await buildOpenSeaMintTransaction(spec.slug, { cfg, fetchImpl, minter: schedule.wallet_address, quantity });
    if (String(payload.chain || '').toLowerCase() !== expectedChain) throw new MintSpecError('OpenSea transaction is for a different chain.');
    resolved.quantity = quantity;
    // The adapter compares against the internal chain key; the OpenSea identifier was checked above.
    resolved.transaction = { chain: schedule.chain, to: payload.to, data: payload.data, value: payload.value };
  }

  if (spec.adapter === 'merkle' && spec.proof === undefined) {
    const provider = configuredProvider(spec, schedule, cfg, 'merkle');
    if (!provider) throw new MintSpecError('Merkle adapter requires an inline proof or a configured providerId.');
    const { data, label } = await fetchFromProvider(provider, schedule, quantity, fetchImpl);
    if (!Array.isArray(data.proof)) throw new ProviderError(`${label} response must contain a proof array.`);
    resolved.proof = data.proof;
  }

  if (spec.adapter === 'signature' && spec.signature === undefined) {
    const provider = configuredProvider(spec, schedule, cfg, 'signature');
    if (!provider) throw new MintSpecError('Signature adapter requires an inline signature or a configured providerId.');
    const { data, label } = await fetchFromProvider(provider, schedule, quantity, fetchImpl);
    if (typeof data.signature !== 'string') throw new ProviderError(`${label} response must contain a signature.`);
    for (const key of ['signature', 'maxQuantity', 'nonce', 'deadline']) if (data[key] !== undefined) resolved[key] = data[key];
  }

  if (spec.adapter === 'seadrop-signed') {
    const provider = configuredProvider(spec, schedule, cfg, 'seadrop-signed');
    if (!provider) throw new MintSpecError('SeaDrop signed mints require a configured providerId.');
    const { data } = await fetchFromProvider(provider, schedule, quantity, fetchImpl);
    if (data.signature !== undefined) resolved.signature = data.signature;
    if (data.salt !== undefined) resolved.salt = data.salt;
    if (data.mintParams || data.params) resolved.mintParams = data.mintParams || data.params;
    for (const key of ['feeRecipient', 'minterIfNotPayer']) if (data[key] !== undefined) resolved[key] = data[key];
  }

  if (resolved.adapter === 'signature' && resolved.deadline !== undefined && BigInt(resolved.deadline) <= BigInt(now)) {
    throw new MintSpecError('Mint signature has expired.');
  }
  if (resolved.adapter === 'seadrop-signed' && resolved.mintParams?.endTime !== undefined && BigInt(resolved.mintParams.endTime) <= BigInt(now)) {
    throw new MintSpecError('SeaDrop signed mint phase has expired.');
  }
  return resolved;
}

module.exports = { resolveMintSpec, readJsonUrl, assertNoUserSources, USER_SOURCE_KEYS, MAX_PROVIDER_BYTES };
