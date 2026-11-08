'use strict';
// End-to-end regressions for the code review (docs/REVIEW.md). Each test is one of the original
// reproductions (R1–R12) inverted: it now asserts the FIXED behaviour, using the real worker,
// the real executor and a real signing key against a fake chain.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Interface, Network, Transaction } = require('ethers');
const { T0, A, makeCfg, makeDb, addUser, addSignableWallet, fakeTg, getChains, silent } = require('./helpers');
const { createWorker } = require('../../src/worker');
const { createFastExecution } = require('../../src/core/fastExecution');
const { createSchedule, getSchedule, ScheduleError } = require('../../src/core/schedules');
const { resolveMintSpec } = require('../../src/core/eligibilityProviders');
const { assertDropMatchesSchedule } = require('../../src/core/openSeaDrops');
const { buildFromSpec } = require('../../src/core/mintAdapters');
const { addTrackedTx } = require('../../src/core/tracking');
const { registerReferral } = require('../../src/core/referrals');
const { getUser } = require('../../src/core/users');
const { SEADROP_ERRORS } = require('../../src/core/outcomes');

const NFT = A(5);
const ROUTER = '0x00005ea00ac477b1030ce78506496e8c2de24bf5';
const flush = () => new Promise((r) => setImmediate(r));

/** Real worker + real executor. `chain` state is mutable from the test (open/closed, balance, broadcast behaviour). */
function e2e({ automation = {}, cfgOver = {}, chainKey = 'base' } = {}) {
  const cfg = makeCfg(cfgOver);
  cfg.automation = { ...cfg.automation, ...automation };
  cfg.launch = { ...cfg.launch, engine: false }; // tick path; test/unit/launch-engine.test.js covers the engine
  const chains = getChains(cfg);
  const db = makeDb(); const tg = fakeTg();
  let t = T0;
  const chain = { open: true, revertData: '0x', balance: 10n ** 18n, broadcasts: [], broadcastError: null, known: new Set(), simulations: 0 };
  const provider = {
    getNetwork: async () => Network.from(chains[chainKey].chainId),
    getTransactionCount: async () => 3,
    getFeeData: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    broadcastTransaction: async (raw) => {
      if (chain.broadcastError) throw chain.broadcastError;
      chain.broadcasts.push(raw); chain.known.add(Transaction.from(raw).hash); return {};
    }
  };
  const rpc = {
    provider: async () => provider,
    broadcast: async (key, raw) => { await provider.broadcastTransaction(raw); return { hash: Transaction.from(raw).hash, ackMs: 1 }; },
    getFeeInputs: async () => ({ baseFeePerGas: 1n, priorityFeePerGas: 0n, gasPrice: null, timestamp: t, number: 1 }),
    getChainTime: async () => t,
    getBalance: async () => chain.balance.toString(),
    estimateGas: async () => { if (!chain.open) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: chain.revertData }); return 90000n; },
    getFeeData: async () => ({ maxFeePerGas: 2n }),
    simulate: async () => { chain.simulations += 1; return chain.open ? { ok: true } : { ok: false, reason: 'execution reverted', data: chain.revertData }; },
    getAllowedSeaDrop: async () => [ROUTER],
    getTransaction: async (key, hash) => (chain.known.has(hash) ? { hash } : null),
    getNonce: async () => 3,
    getReceipt: async () => null,
    parseReceivedTokenIds: () => []
  };
  const fastExecution = createFastExecution({ rpc, db, cfg, chains, log: silent, now: () => t });
  const worker = createWorker({ db, cfg, tg, rpc, chains, fastExecution, now: () => t, log: silent });
  const user = (id, opts) => { addUser(db, id, opts); return addSignableWallet(db, cfg, id).address; };
  const tick = async () => { await worker.tick(); await flush(); };
  return { cfg, chains, db, tg, rpc, chain, worker, user, tick, setNow: (x) => { t = x; } };
}
const preset = (wallet, over = {}) => ({ telegramId: 1, chain: 'base', contract: NFT, preset: 'mint(uint256)', quantity: 1, priceWei: '0.001', scheduledAt: T0 + 3600, wallet, ...over });

test('R1 fixed: AUTOMATION_DRY_RUN=true simulates, estimates gas and reports, without signing', async () => {
  const e = e2e({ automation: { dryRun: true } });
  const id = createSchedule(e.db, e.cfg, e.chains, preset(e.user(1)), T0);
  e.setNow(T0 + 3600); await e.tick();
  assert.equal(getSchedule(e.db, id).status, 'ready');
  assert.equal(e.chain.simulations, 1);
  assert.equal(e.chain.broadcasts.length, 0);
  assert.match(e.tg.texts().join('\n'), /Dry run passed: would send 0\.001 ETH/);
});

test('R2 fixed: a chain that cannot be auto-signed is refused when the schedule is created, not at mint time', () => {
  const e = e2e({ automation: { allowedChains: ['base'] } });
  assert.throws(() => createSchedule(e.db, e.cfg, e.chains, preset(e.user(1), { chain: 'ethereum' }), T0), (err) => err instanceof ScheduleError && /not enabled for Ethereum/.test(err.message));
});

test('R3 fixed: "when the mint opens" keeps retrying a not-yet-open generic contract, then mints when it opens', async () => {
  const e = e2e();
  const id = createSchedule(e.db, e.cfg, e.chains, preset(e.user(1), { triggerMode: 'launch', scheduledAt: T0, launchAt: T0 + 60 }), T0);
  e.chain.open = false;
  e.setNow(T0 + 30); await e.tick();
  assert.equal(e.chain.simulations, 0, 'nothing before the chain reaches the opening time');
  for (const dt of [60, 75, 90, 105]) { e.setNow(T0 + dt); await e.tick(); }
  assert.equal(getSchedule(e.db, id).status, 'scheduled', 'a revert inside the grace window is "not open yet"');
  e.chain.open = true;
  e.setNow(T0 + 120); await e.tick();
  assert.equal(getSchedule(e.db, id).status, 'submitted');
  assert.equal(e.chain.broadcasts.length, 1);
});

test('R3 fixed: a SeaDrop NotActive revert waits until the stage end; a sold-out revert stops at once', async () => {
  const e = e2e();
  const wallet = e.user(1);
  const waiting = createSchedule(e.db, e.cfg, e.chains, preset(wallet, { triggerMode: 'launch', scheduledAt: T0, launchAt: T0 + 10 }), T0);
  e.chain.open = false;
  e.chain.revertData = SEADROP_ERRORS.encodeErrorResult('NotActive', [T0 + 500, T0 + 900, T0 + 99999]);
  e.setNow(T0 + 500); await e.tick();
  assert.equal(getSchedule(e.db, waiting).status, 'scheduled', 'NotActive beyond the grace window still waits');
  assert.equal(getSchedule(e.db, waiting).next_attempt_at, T0 + 900, 'the next attempt is aimed at the stage start from the revert');
  e.setNow(T0 + 899); await e.tick();
  assert.equal(e.chain.simulations, 1, 'no polling before the stage start');
  e.chain.revertData = SEADROP_ERRORS.encodeErrorResult('MintQuantityExceedsMaxSupply', [11, 10]);
  e.setNow(T0 + 900); await e.tick();
  assert.equal(getSchedule(e.db, waiting).status, 'failed');
  assert.match(e.tg.texts().join('\n'), /sold out/);
});

test('R4 fixed: an ineligible OpenSea wallet costs one API write, fails once with a message, and never loops', async () => {
  const realFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async () => { posts += 1; return new Response(JSON.stringify({ code: 'MINTER_NOT_ELIGIBLE', errors: ['Minter is not on the allowlist'] }), { status: 422 }); };
  try {
    const e = e2e({ cfgOver: { openSeaApiKey: 'regress-r4' } });
    const id = createSchedule(e.db, e.cfg, e.chains, preset(e.user(1), { preset: undefined, mintSpec: { adapter: 'opensea-drop', slug: 'drop', quantity: 1, priceWei: '1000', feeBps: 1000 }, priceWei: 1000n, triggerMode: 'launch', scheduledAt: T0, launchAt: T0 + 10 }), T0);
    for (let i = 1; i <= 40; i++) { e.setNow(T0 + 10 + i * 15); await e.tick(); }
    assert.equal(posts, 1);
    assert.equal(getSchedule(e.db, id).status, 'failed');
    assert.equal(e.tg.texts().filter((x) => /allowlist/.test(x)).length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('R4 fixed: NOT_MINTING backs off and the schedule expires at its deadline instead of retrying forever', async () => {
  const realFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async () => { posts += 1; return new Response(JSON.stringify({ code: 'NOT_MINTING', errors: ['not minting'] }), { status: 409 }); };
  try {
    const e = e2e({ cfgOver: { openSeaApiKey: 'regress-r4b' } });
    const id = createSchedule(e.db, e.cfg, e.chains, preset(e.user(1), { preset: undefined, mintSpec: { adapter: 'opensea-drop', slug: 'drop', quantity: 1, priceWei: '1000', feeBps: 1000 }, priceWei: 1000n, triggerMode: 'launch', scheduledAt: T0, launchAt: T0 + 10 }), T0);
    for (let i = 1; i <= 240; i++) { e.setNow(T0 + 10 + i * 15); await e.tick(); } // one hour of ticks
    assert.ok(posts < 25, `backoff limits OpenSea writes (got ${posts} in an hour, previously 240)`);
    e.setNow(T0 + 10 + 21600 + 1); await e.tick();
    assert.equal(getSchedule(e.db, id).status, 'expired');
  } finally { globalThis.fetch = realFetch; }
});

test('R5 fixed: proofFile is rejected and no file content reaches the user', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const secret = path.join(dir, '.env');
  fs.writeFileSync(secret, 'TELEGRAM_BOT_TOKEN=123456789:AAH-secret\n');
  await assert.rejects(
    resolveMintSpec({ adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, priceWei: '0', proofFile: secret }, { contract: NFT, wallet_address: A(1), chain: 'base', quantity: 1 }, { now: T0 }),
    (err) => /not accepted/.test(err.message) && !/TELEGRAM_B/.test(err.message)
  );
});

test('R6 fixed: a user-supplied URL never makes the server send a request', async () => {
  let hit = false;
  const server = http.createServer((req, res) => { hit = true; res.end('{"proof":[]}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const spec = { adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, priceWei: '0', proofUrl: `http://127.0.0.1:${server.address().port}/internal/admin` };
    await assert.rejects(resolveMintSpec(spec, { contract: NFT, wallet_address: A(1), chain: 'base', quantity: 1 }, { now: T0 }), /not accepted/);
    assert.equal(hit, false);
  } finally { server.close(); }
});

test('R7 fixed: OpenSea chain identifiers are mapped, and unmapped chains fail closed with a clear reason', () => {
  const drop = { drop_type: 'seadrop_v1_erc721', collection_slug: 'x', chain: 'base', contract_address: NFT };
  assert.doesNotThrow(() => assertDropMatchesSchedule(drop, { chain: 'base', contract: NFT }, 'x'));
  assert.throws(() => assertDropMatchesSchedule({ ...drop, chain: 'base_sepolia' }, { chain: 'base-sepolia', contract: NFT }, 'x'), /not supported on base-sepolia/);
});

test('R8 fixed: a SeaDrop signed schedule stores the live price and mints at the provider price', async () => {
  const realFetch = globalThis.fetch;
  const e = e2e();
  const wallet = e.user(1);
  e.cfg.eligibilityProviders = { issuer: { kind: 'seadrop-signed', url: 'https://issuer.example/sig', method: 'GET' } };
  const mintParams = { mintPrice: '1000000000000000', maxTotalMintableByWallet: '2', startTime: '1', endTime: String(T0 + 99999), dropStageIndex: '1', maxTokenSupplyForStage: '100', feeBps: '1000', restrictFeeRecipients: true };
  globalThis.fetch = async () => new Response(JSON.stringify({ address: wallet, signature: '0x' + 'ab'.repeat(65), salt: '7', mintParams }), { status: 200 });
  try {
    // What the wizard now stores: the provider's live price, not the user's typed priceWei.
    const spec = { adapter: 'seadrop-signed', providerId: 'issuer', seaDropContract: ROUTER, feeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719', quantity: 1, mintPrice: mintParams.mintPrice };
    const id = createSchedule(e.db, e.cfg, e.chains, preset(wallet, { preset: undefined, mintSpec: spec, priceWei: BigInt(mintParams.mintPrice) }), T0);
    assert.equal(getSchedule(e.db, id).total_wei, mintParams.mintPrice);
    e.setNow(T0 + 3600); await e.tick();
    assert.equal(getSchedule(e.db, id).status, 'submitted');
    assert.equal(Transaction.from(e.chain.broadcasts[0]).value, 10n ** 15n);
  } finally { globalThis.fetch = realFetch; }
});

test('R9 fixed: SeaDrop adapters refuse an nftContract other than the scheduled contract', () => {
  assert.throws(() => buildFromSpec({ adapter: 'seadrop', seaDropContract: A(9), nftContract: A(77), feeRecipient: A(8), mintPrice: '0', quantity: 1 }, { contract: NFT, wallet_address: A(1), quantity: 1, price_wei: '0' }), /nftContract must match/);
});

test('R10 superseded (mainnets only): any allowlisted registry mainnet signs and broadcasts live with its own chain id', async () => {
  const e = e2e({ automation: { allowedChains: ['soneium'] }, chainKey: 'soneium' });
  const owner = e.user(1);
  const id = createSchedule(e.db, e.cfg, e.chains, preset(owner, { chain: 'soneium' }), T0);
  e.setNow(T0 + 3600); await e.tick();
  assert.equal(getSchedule(e.db, id).status, 'submitted');
  assert.equal(Transaction.from(e.chain.broadcasts[0]).chainId, 1868n);
  assert.throws(() => createSchedule(e.db, e.cfg, e.chains, preset(owner, { chain: 'base-sepolia' }), T0), /Unsupported network/);
});

test('R11 fixed: a node rejection before broadcast waits for funds with one notice, then mints after a top-up', async () => {
  const e = e2e();
  const id = createSchedule(e.db, e.cfg, e.chains, preset(e.user(1)), T0);
  e.chain.broadcastError = Object.assign(new Error('insufficient funds for gas * price + value'), { code: 'INSUFFICIENT_FUNDS' });
  for (const dt of [0, 15, 30]) { e.setNow(T0 + 3600 + dt); await e.tick(); }
  assert.equal(getSchedule(e.db, id).status, 'scheduled');
  assert.equal(e.db.prepare("SELECT COUNT(*) n FROM execution_attempts WHERE schedule_id=? AND status='failed'").get(id).n, 3);
  assert.equal(e.tg.texts().filter((x) => /insufficient funds/.test(x)).length, 1);
  e.chain.broadcastError = null;
  e.setNow(T0 + 3645); await e.tick();
  assert.equal(getSchedule(e.db, id).status, 'submitted');
});

test('R11 fixed: an ambiguous broadcast is reconciled by hash on the next pass, with no second signature', async () => {
  const e = e2e();
  const id = createSchedule(e.db, e.cfg, e.chains, preset(e.user(1)), T0);
  let first = null;
  e.chain.broadcastError = Object.assign(new Error('socket hang up'), { code: 'NETWORK_ERROR' });
  const realBroadcast = (await e.rpc.provider()).broadcastTransaction;
  (await e.rpc.provider()).broadcastTransaction = async (raw) => { first = first || raw; return realBroadcast(raw); };
  e.setNow(T0 + 3600); await e.tick();
  assert.equal(getSchedule(e.db, id).status, 'scheduled');
  e.chain.broadcastError = null; // the node actually accepts the re-sent identical bytes
  e.setNow(T0 + 3630); await e.tick();
  assert.equal(getSchedule(e.db, id).status, 'submitted');
  assert.equal(getSchedule(e.db, id).tx_hash, Transaction.from(first).hash);
  assert.equal(new Set(e.chain.broadcasts).size, 1, 'only one distinct signed transaction ever existed');
});

test('R12 fixed: referral rewards are paid on the referee\'s first confirmed mint', async () => {
  const e = e2e();
  const referrer = addUser(e.db, 60);
  const id = createSchedule(e.db, e.cfg, e.chains, preset(e.user(61), { telegramId: 61 }), T0);
  registerReferral(e.db, 61, referrer.ref_code, T0);
  e.setNow(T0 + 3600); await e.tick();
  const hash = getSchedule(e.db, id).tx_hash;
  addTrackedTx(e.db, e.cfg, { telegramId: 61, chain: 'base', txHash: hash, scheduleId: id, system: true }, T0 + 3600);
  e.rpc.getReceipt = async () => ({ status: 'confirmed', blockNumber: 1, confirmations: 1, logs: [] });
  e.setNow(T0 + 3700); await e.tick();
  assert.equal(getSchedule(e.db, id).status, 'confirmed');
  assert.ok(getUser(e.db, 60).premium_until > T0);
});

test('ERC-1155 TransferSingle/TransferBatch receipts report minted token ids', () => {
  const { parseReceivedTokenIds } = require('../../src/core/rpc');
  const iface = new Interface([
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
  ]);
  const wallet = A(1);
  const zero = '0x0000000000000000000000000000000000000000';
  const single = iface.encodeEventLog('TransferSingle', [A(9), zero, wallet, 7, 1]);
  const batch = iface.encodeEventLog('TransferBatch', [A(9), zero, wallet, [8, 9], [1, 3]]);
  const other = iface.encodeEventLog('TransferSingle', [A(9), zero, A(2), 10, 1]);
  assert.deepEqual(parseReceivedTokenIds([single, batch, other], [wallet]), ['7', '8', '9 ×3']);
});
