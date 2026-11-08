'use strict';
const { loadConfig } = require('../../src/config');
const { openDb } = require('../../src/db');
const { getChains } = require('../../src/chains');
const { upsertUser, extendPremium } = require('../../src/core/users');
const { linkWallet } = require('../../src/core/wallets');

const T0 = 1_800_000_000; // fixed "now" for deterministic tests
const A = (n) => '0x' + String(n).padStart(40, '0'); // fake lowercase addresses

const TEST_MASTER_KEY = 'aa'.repeat(32);
// Unit tests run with live automatic signing enabled (MintPilot has no manual signing path).
function makeCfg(over = {}) {
  const base = loadConfig({
    ADMIN_TELEGRAM_IDS: '999', PUBLIC_URL: 'https://bot.example',
    AUTOMATION_ENABLED: 'true', AUTOMATION_DRY_RUN: 'false', AUTOMATION_MASTER_KEY: TEST_MASTER_KEY
  });
  return { ...base, ...over };
}
function makeDb() { return openDb(':memory:'); }
function addUser(db, id, { premium = false, now = T0 } = {}) {
  const { user } = upsertUser(db, { id, username: `u${id}` }, now);
  if (premium) extendPremium(db, id, 30, now);
  return user;
}
// Placeholder custody blob: enough for "has a signing key" checks; it does not decrypt.
const PLACEHOLDER_KEY = { ciphertext: 'test', iv: 'test', authTag: 'test', salt: 'test' };
function addWallet(db, cfg, id, addr, now = T0, { signable = true } = {}) { return linkWallet(db, cfg, id, addr, signable ? 'custodial' : 'eoa', now, signable ? PLACEHOLDER_KEY : null); }
/** A real custodial wallet whose sealed key decrypts with the test master key. */
function addSignableWallet(db, cfg, id, now = T0) {
  const { Wallet } = require('ethers');
  const { seal } = require('../../src/core/custodialWallets');
  const wallet = Wallet.createRandom();
  linkWallet(db, cfg, id, wallet.address.toLowerCase(), 'custodial', now, seal(wallet.privateKey, cfg.automation.encryptionKey));
  return { address: wallet.address.toLowerCase(), privateKey: wallet.privateKey };
}

function fakeTg() {
  const calls = [];
  let seq = 1000;
  const rec = (method) => async (...args) => { calls.push({ method, args }); return {}; };
  // What the user currently sees: every sent message, and every edit shown as the text it now has.
  const shown = () => calls.flatMap((c) => (c.method === 'sendMessage' ? [c] : c.method === 'editMessageText' ? [{ method: 'sendMessage', args: [c.args[0], c.args[2], c.args[3]] }] : []));
  const tg = {
    calls,
    sendMessage: async (...args) => { calls.push({ method: 'sendMessage', args }); seq += 1; return { message_id: seq }; },
    editMessageText: rec('editMessageText'), deleteMessage: rec('deleteMessage'), answerCallbackQuery: rec('answerCallbackQuery'),
    sendInvoice: rec('sendInvoice'), answerPreCheckoutQuery: rec('answerPreCheckoutQuery'),
    texts: () => shown().map((c) => c.args[1]),
    last: () => shown().at(-1)
  };
  return tg;
}
const silent = { error() {}, log() {}, warn() {}, info() {} };

/**
 * Local Hardhat chain for contract tests ONLY. The production registry (src/chains.js) is mainnet-only;
 * tests that need a real local EVM add this definition to the chain map they build.
 */
const localChain = (rpcUrls = ['http://127.0.0.1:8545']) => ({
  key: 'localhost', name: 'Local Hardhat', chainId: 31337, currency: 'ETH', confirmations: 1, stack: 'ethereum',
  defaultRpc: rpcUrls[0], explorer: 'http://127.0.0.1:8545', abiApi: null, opensea: null, ordering: 'fee',
  rpcUrl: rpcUrls[0], rpcUrls
});

module.exports = { T0, A, TEST_MASTER_KEY, makeCfg, makeDb, addUser, addWallet, addSignableWallet, fakeTg, silent, getChains, localChain };
