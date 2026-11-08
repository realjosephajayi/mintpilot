'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { resolveMintSpec, readJsonUrl, MAX_PROVIDER_BYTES } = require('../../src/core/eligibilityProviders');
const { classifyPreparationError, OUTCOME } = require('../../src/core/outcomes');
const { ProviderError, MintSpecError } = require('../../src/core/errors');

const contract = '0x1111111111111111111111111111111111111111';
const wallet = '0x2222222222222222222222222222222222222222';
const proof = ['0x' + 'aa'.repeat(32)];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const providers = (entries) => ({ eligibilityProviders: entries });

test('file and URL sources supplied in a spec are rejected before any I/O (review #1)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintpilot-proof-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'TELEGRAM_BOT_TOKEN=secret');
  let fetched = false;
  const fetchImpl = async () => { fetched = true; return json({ proof }); };
  for (const extra of [{ proofFile: file }, { proofFile: '/dev/zero' }, { proofUrl: 'https://issuer.example/p' }, { signatureUrl: 'http://127.0.0.1:1/x' }, { signatureFile: file }]) {
    await assert.rejects(() => resolveMintSpec({ adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, ...extra }, { contract, wallet_address: wallet, chain: 'base', quantity: 1 }, { now: 1, fetchImpl }),
      (e) => e instanceof MintSpecError && /not accepted/.test(e.message) && !/TELEGRAM/.test(e.message));
  }
  assert.equal(fetched, false);
});

test('Merkle proofs come from an operator provider by id, bound to the wallet', async () => {
  let requested;
  const fetchImpl = async (url) => { requested = new URL(url); return json({ address: wallet, proof }); };
  const cfg = providers({ proofs: { kind: 'merkle', url: 'https://issuer.example/proof', method: 'GET' } });
  const result = await resolveMintSpec({ adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, providerId: 'proofs' }, { contract, wallet_address: wallet, chain: 'base', quantity: 1 }, { now: 100, fetchImpl, cfg });
  assert.deepEqual(result.proof, proof);
  assert.equal(requested.searchParams.get('address'), wallet);
  assert.equal(requested.searchParams.get('contract'), contract);
  await assert.rejects(() => resolveMintSpec({ adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, providerId: 'proofs' }, { contract, wallet_address: wallet, chain: 'base', quantity: 1 }, { now: 100, cfg, fetchImpl: async () => json({ address: contract, proof }) }), /different wallet/);
  await assert.rejects(() => resolveMintSpec({ adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 1 }, { contract, wallet_address: wallet, chain: 'base', quantity: 1 }, { now: 100, cfg }), /inline proof or a configured providerId/);
});

test('signature provider fills signature fields; expired signatures are rejected', async () => {
  const cfg = providers({ sigs: { kind: 'signature', url: 'https://issuer.example/mint', method: 'GET' } });
  const fetchImpl = async () => json({ signature: '0x12', maxQuantity: 1, nonce: 4, deadline: 200 });
  const result = await resolveMintSpec({ adapter: 'signature', mintFunction: 'mint(uint256,uint256,uint256,uint256,bytes)', providerId: 'sigs', quantity: 1 }, { contract, wallet_address: wallet, chain: 'base', quantity: 1 }, { now: 100, fetchImpl, cfg });
  assert.equal(result.signature, '0x12');
  assert.equal(result.nonce, 4);
  await assert.rejects(() => resolveMintSpec({ adapter: 'signature', signature: '0x12', deadline: 100 }, { contract, wallet_address: wallet }, { now: 100 }), /expired/);
});

test('a provider of the wrong kind, chain or contract is refused', async () => {
  const cfg = providers({ p: { kind: 'merkle', url: 'https://issuer.example/x', method: 'GET', chain: 'ethereum', contract } });
  await assert.rejects(() => resolveMintSpec({ adapter: 'signature', mintFunction: 'x', providerId: 'p', quantity: 1 }, { contract, wallet_address: wallet, chain: 'ethereum', quantity: 1 }, { cfg }), /serves merkle, not signature/);
  await assert.rejects(() => resolveMintSpec({ adapter: 'merkle', providerId: 'p', quantity: 1 }, { contract, wallet_address: wallet, chain: 'base', quantity: 1 }, { cfg }), /not configured for base/);
  await assert.rejects(() => resolveMintSpec({ adapter: 'merkle', providerId: 'p', quantity: 1 }, { contract: wallet, wallet_address: wallet, chain: 'ethereum', quantity: 1 }, { cfg }), /not configured for this NFT contract/);
});

test('provider fetch refuses redirects, caps the body size, and never echoes the body or URL', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(options.redirect); return new Response('x'.repeat(MAX_PROVIDER_BYTES + 1), { status: 200 }); };
  await assert.rejects(() => readJsonUrl('https://issuer.example/secret-path?token=abc', 'Provider "p"', fetchImpl), (e) => e instanceof ProviderError && /oversized/.test(e.message) && !/secret-path|token/.test(e.message));
  assert.deepEqual(seen, ['error']);
  await assert.rejects(() => readJsonUrl('https://issuer.example/x', 'Provider "p"', async () => new Response('TELEGRAM_BOT_TOKEN=1', { status: 200 })), (e) => /invalid JSON/.test(e.message) && !/TELEGRAM/.test(e.message));
  await assert.rejects(() => readJsonUrl('https://issuer.example/x', 'Provider "p"', async () => new Response('{}', { status: 404 })), (e) => e.status === 404 && e.retryable === false);
  await assert.rejects(() => readJsonUrl('https://issuer.example/x', 'Provider "p"', async () => new Response('{}', { status: 503 })), (e) => e.retryable === true);
  await assert.rejects(() => readJsonUrl('https://issuer.example/x', 'Provider "p"', async () => { throw new Error('ECONNRESET'); }), (e) => e.retryable === true);
});

test('real redirects are not followed by the provider client', async () => {
  let redirectedHit = false;
  const target = http.createServer((req, res) => { redirectedHit = true; res.end('{}'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const origin = http.createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/internal` }); res.end(); });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(() => readJsonUrl(`http://127.0.0.1:${origin.address().port}/start`, 'Provider "p"'), (e) => e instanceof ProviderError);
    assert.equal(redirectedHit, false);
  } finally { origin.close(); target.close(); }
});

test('plain-HTTP localhost providers are refused in production (review #1)', async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(() => readJsonUrl('http://127.0.0.1:9/x', 'Provider "p"', async () => json({})), /HTTPS required/);
    await assert.rejects(() => readJsonUrl('http://[::1]:9/x', 'Provider "p"', async () => json({})), /HTTPS required/);
  } finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
  assert.deepEqual(await readJsonUrl('http://[::1]:9/x', 'Provider "p"', async () => json({ ok: 1 })), { ok: 1 });
});

test('configured SeaDrop provider receives the wallet-bound request and returns live payload', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: new URL(url), options };
    return json({
      address: wallet, nftContract: contract, chain: 'robinhood', quantity: 1,
      signature: '0x' + 'ab'.repeat(65), salt: '9',
      mintParams: { mintPrice: '0', maxTotalMintableByWallet: '1', startTime: '50', endTime: '200', dropStageIndex: '3', maxTokenSupplyForStage: '10000', feeBps: '1000', restrictFeeRecipients: true }
    });
  };
  const result = await resolveMintSpec({ adapter: 'seadrop-signed', providerId: 'issuer', seaDropContract: contract, nftContract: contract, feeRecipient: wallet, quantity: 1 }, { contract, wallet_address: wallet, chain: 'robinhood', quantity: 1 }, {
    now: 100, fetchImpl, cfg: providers({ issuer: { kind: 'seadrop-signed', url: 'https://issuer.example/mint', method: 'POST', chain: 'robinhood', contract } })
  });
  assert.equal(request.url.pathname, '/mint');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body), { address: wallet, wallet, chain: 'robinhood', contract, quantity: 1 });
  assert.equal(result.signature, '0x' + 'ab'.repeat(65));
  assert.equal(result.mintParams.dropStageIndex, '3');
});

test('SeaDrop provider rejects a payload for another wallet or contract; providerId is mandatory', async () => {
  const cfg = providers({ issuer: { kind: 'seadrop-signed', url: 'https://issuer.example/mint', method: 'GET', chain: 'robinhood', contract } });
  const fetchImpl = async () => json({ address: contract, nftContract: wallet, signature: '0x12', salt: '1', mintParams: {} });
  await assert.rejects(() => resolveMintSpec({ adapter: 'seadrop-signed', providerId: 'issuer', seaDropContract: contract, feeRecipient: wallet, quantity: 1 }, { contract, wallet_address: wallet, chain: 'robinhood', quantity: 1 }, { now: 100, fetchImpl, cfg }), /different wallet/);
  await assert.rejects(() => resolveMintSpec({ adapter: 'seadrop-signed', providerId: 'missing', quantity: 1 }, { contract, wallet_address: wallet, chain: 'robinhood', quantity: 1 }, { now: 100, cfg }), /not configured/);
  await assert.rejects(() => resolveMintSpec({ adapter: 'seadrop-signed', quantity: 1 }, { contract, wallet_address: wallet, chain: 'robinhood', quantity: 1 }, { now: 100, cfg }), /require a configured providerId/);
});

test('OpenSea REST resolver requests a fresh transaction and checks the OpenSea chain identifier', async () => {
  let request;
  const fetchImpl = async (url, options) => { request = { url: new URL(url), options }; return json({ chain: 'base', to: '0x3333333333333333333333333333333333333333', data: '0x12345678', value: '7' }); };
  const result = await resolveMintSpec({ adapter: 'opensea-drop', slug: 'example-drop', quantity: 2, priceWei: '10' }, { contract, wallet_address: wallet, chain: 'base', quantity: 2, total_wei: '20' }, { fetchImpl, cfg: { openSeaApiKey: 'server-key' } });
  assert.equal(request.url.pathname, '/api/v2/drops/example-drop/mint');
  assert.equal(request.options.headers['x-api-key'], 'server-key');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body), { minter: wallet, quantity: 2 });
  assert.deepEqual(result.transaction, { chain: 'base', to: '0x3333333333333333333333333333333333333333', data: '0x12345678', value: '7' });
  await assert.rejects(() => resolveMintSpec({ adapter: 'opensea-drop', slug: 'example-drop', quantity: 1 }, { contract, wallet_address: wallet, chain: 'base', quantity: 1 }, { fetchImpl: async () => json({ chain: 'ethereum', to: contract, data: '0x12', value: '0' }), cfg: { openSeaApiKey: 'chain-key' } }), /different chain/);
  await assert.rejects(() => resolveMintSpec({ adapter: 'opensea-drop', slug: 'example-drop', quantity: 1 }, { contract, wallet_address: wallet, chain: 'local-dev', quantity: 1 }, { cfg: { openSeaApiKey: 'k' } }), /not supported on local-dev/);
});

test('OpenSea error codes map to outcomes: NOT_MINTING waits, eligibility codes are terminal, 429/5xx retry (review #3)', async () => {
  const reject = async (status, body, key) => {
    try {
      await resolveMintSpec({ adapter: 'opensea-drop', slug: 'example-drop', quantity: 1 }, { contract, wallet_address: wallet, chain: 'base', quantity: 1 }, { cfg: { openSeaApiKey: key }, fetchImpl: async () => json(body, status) });
    } catch (e) { return classifyPreparationError(e); }
    throw new Error('expected rejection');
  };
  assert.equal((await reject(409, { code: 'NOT_MINTING', errors: ['not minting'] }, 'k409')).outcome, OUTCOME.WAIT);
  for (const code of ['MINTER_NOT_ELIGIBLE', 'MINT_LIMIT_EXCEEDED', 'SUPPLY_EXHAUSTED', 'NO_PAYOUT_ADDRESS']) {
    assert.equal((await reject(422, { code, errors: [code] }, `k-${code}`)).outcome, OUTCOME.TERMINAL, code);
  }
  const funds = await reject(422, { code: 'INSUFFICIENT_BALANCE', errors: ['balance'] }, 'kfunds');
  assert.equal(funds.outcome, OUTCOME.WAIT);
  assert.equal(funds.notify, 'funds');
  assert.equal((await reject(400, { code: 'UNSUPPORTED_DROP_TYPE', errors: ['1155'] }, 'k400')).outcome, OUTCOME.TERMINAL);
  assert.equal((await reject(503, { errors: ['down'] }, 'k503')).outcome, OUTCOME.RETRY);
});
