'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface } = require('ethers');
const { runPreflight } = require('../../src/core/preflight');
const { buildMintTx } = require('../../src/core/mintTx');
const { A, T0, makeCfg, makeDb, addUser, addSignableWallet, addWallet } = require('./helpers');
const { SEADROP_ERRORS } = require('../../src/core/outcomes');

const contract = A(2);
const router = A(3);
const CHAINS = { robinhood: { key: 'robinhood', chainId: 4663, name: 'Robinhood Chain' }, base: { key: 'base', chainId: 8453, name: 'Base' } };

function setup({ signable = true } = {}) {
  const cfg = makeCfg(); const db = makeDb();
  addUser(db, 1);
  const wallet = signable ? addSignableWallet(db, cfg, 1).address : (addWallet(db, cfg, 1, A(1), T0, { signable: false }), A(1));
  return { cfg, db, wallet };
}
const provider = (over = {}) => ({ send: async () => '0x1237', getBlockNumber: async () => 10, getTransactionCount: async () => 4, estimateGas: async () => 50000n, getFeeData: async () => ({ gasPrice: 1n }), ...over });

test('preflight runs every check, including the automatic-signing gate and signing key, without submitting', async () => {
  const { cfg, db, wallet } = setup();
  const schedule = { id: 41, telegram_id: '1', wallet_address: wallet, chain: 'robinhood', contract, total_wei: '100', quantity: 1, preset: 'mint()' };
  const result = await runPreflight({
    schedule, cfg, chains: CHAINS,
    rpc: { provider: async () => provider(), getBalance: async () => '1000000', simulate: async () => ({ ok: true }), getChainTime: async () => 100 },
    buildMintTx: () => ({ from: wallet, to: contract, data: '0x1234', value: '0x64', valueWei: '100', quantity: 1 }),
    db, now: 100
  });
  assert.deepEqual(result.checks.map((c) => c.name), ['automation', 'signing-key', 'rpc-chain-id', 'rpc-latency', 'live-data', 'phase-window', 'transaction', 'router-authorized', 'wallet-balance', 'gas-estimate', 'simulation', 'nonce-available', 'submission-state']);
  assert.equal(result.ready, true);
  const gas = result.checks.find((x) => x.name === 'gas-estimate');
  assert.equal(gas.gasLimit, '62500', 'estimate × 1.25');
  assert.equal(gas.gasCap, '300000');
});

test('preflight reports a missing signing key and a disabled chain', async () => {
  const { cfg, db, wallet } = setup({ signable: false });
  cfg.automation.allowedChains = ['base'];
  const schedule = { id: 42, telegram_id: '1', wallet_address: wallet, chain: 'robinhood', contract, total_wei: '100', quantity: 1, preset: 'mint()' };
  const result = await runPreflight({
    schedule, cfg, chains: CHAINS,
    rpc: { provider: async () => provider(), getBalance: async () => '1000000', simulate: async () => ({ ok: true }) },
    buildMintTx: () => ({ from: wallet, to: contract, data: '0x1234', value: '0x64', valueWei: '100', quantity: 1 }),
    db, now: 100
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find((x) => x.name === 'automation').ok, false);
  assert.equal(result.checks.find((x) => x.name === 'signing-key').ok, false);
});

test('preflight decodes SeaDrop reverts and refuses gas above the policy cap', async () => {
  const { cfg, db, wallet } = setup();
  const schedule = { id: 43, telegram_id: '1', wallet_address: wallet, chain: 'base', contract, total_wei: '100', quantity: 1, preset: 'mint()' };
  const data = SEADROP_ERRORS.encodeErrorResult('MintQuantityExceedsMaxMintedPerWallet', [3, 2]);
  const result = await runPreflight({
    schedule, cfg, chains: CHAINS,
    rpc: { provider: async () => provider({ send: async () => '0x2105', estimateGas: async () => 400000n }), getBalance: async () => '1000000', simulate: async () => ({ ok: false, reason: 'execution reverted', data }) },
    buildMintTx: () => ({ from: wallet, to: contract, data: '0x1234', value: '0x64', valueWei: '100', quantity: 1 }),
    db, now: 100
  });
  assert.equal(result.ready, false);
  assert.match(result.checks.find((x) => x.name === 'simulation').detail, /per-wallet mint limit/);
  assert.match(result.checks.find((x) => x.name === 'gas-estimate').detail, /exceeds the cap 300000/);
});

test('SeaDrop signed preflight fails closed when the live provider payload is not bound to the wallet', async () => {
  const { cfg, db, wallet } = setup();
  cfg.eligibilityProviders = { issuer: { kind: 'seadrop-signed', url: 'https://issuer.example/sig', method: 'GET' } };
  const schedule = { id: 45, telegram_id: '1', wallet_address: wallet, chain: 'base', contract, total_wei: '100', quantity: 1, mint_spec: JSON.stringify({ adapter: 'seadrop-signed', providerId: 'issuer', seaDropContract: router, feeRecipient: A(9), quantity: 1, mintPrice: '100' }) };
  const result = await runPreflight({
    schedule, cfg, chains: CHAINS,
    rpc: { provider: async () => provider({ send: async () => '0x2105' }), getBalance: async () => '1000000', simulate: async () => ({ ok: true }), getAllowedSeaDrop: async () => [router] },
    fetchImpl: async () => new Response(JSON.stringify({ address: A(77), signature: '0x12', salt: '1', mintParams: {} }), { status: 200 }),
    buildMintTx, db, now: 100
  });
  assert.equal(result.ready, false);
  assert.match(result.checks.find((x) => x.name === 'live-data').detail, /different wallet/);
  assert.equal(result.checks.find((x) => x.name === 'transaction').ok, false);
});

test('OpenSea REST preflight validates the authorized router and simulates the exact fresh mint transaction', async () => {
  const { cfg, db, wallet } = setup();
  cfg.openSeaApiKey = 'preflight-key';
  const iface = new Interface(['function mintPublic(address,address,address,uint256) payable']);
  const calldata = iface.encodeFunctionData('mintPublic', [contract, '0x0000a26b00c1F0DF003000390027140000fAa719', '0x0000000000000000000000000000000000000000', 2]);
  let simulated;
  const schedule = {
    id: 44, telegram_id: '1', wallet_address: wallet, chain: 'base', contract, total_wei: '100', price_wei: '50', quantity: 2,
    mint_spec: JSON.stringify({ adapter: 'opensea-drop', slug: 'example-drop', quantity: 2, priceWei: '50', feeBps: 1000 })
  };
  const result = await runPreflight({
    schedule, cfg, chains: CHAINS,
    rpc: {
      provider: async () => provider({ send: async () => '0x2105', estimateGas: async () => 120000n }), getBalance: async () => '1000000', getChainTime: async () => 100,
      getAllowedSeaDrop: async () => [router],
      simulate: async (_chain, tx) => { simulated = tx; return { ok: true }; }
    },
    fetchImpl: async () => new Response(JSON.stringify({ chain: 'base', to: router, data: calldata, value: '90' }), { status: 200 }),
    buildMintTx, db, now: 100
  });
  assert.equal(result.ready, true);
  assert.equal(result.transaction.adapter, 'opensea-drop');
  assert.equal(result.transaction.valueWei, '90');
  assert.equal(simulated.valueWei, '90');
  assert.equal(result.checks.find((x) => x.name === 'router-authorized').ok, true);
  assert.equal(result.checks.find((x) => x.name === 'gas-estimate').gasCap, '400000', 'cap grows with quantity');
});
