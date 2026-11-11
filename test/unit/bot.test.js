'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { T0, A, makeCfg, makeDb, addWallet, fakeTg, getChains, silent } = require('./helpers');
const { createBotHandlers, COMMANDS } = require('../../src/bot/handlers');
const { parseWhen } = require('../../src/util/format');
const { extendPremium, planOf } = require('../../src/core/users');
const { createLimiter } = require('../../src/util/ratelimit');
const { getUser } = require('../../src/core/users');
const { payloadFor } = require('../../src/core/payments');

function boot(over = {}) {
  const cfg = makeCfg(); const db = makeDb(); const chains = getChains(cfg); const tg = fakeTg();
  let t = T0;
  const rpc = { hasCode: async () => true };
  const h = createBotHandlers({ tg, db, cfg, chains, rpc, now: () => t, botUsername: 'mintpilot_bot', limiter: createLimiter({ limit: 1000, windowSec: 60 }), log: silent, ...over });
  let mid = 0;
  const msg = (id, text, extra = {}) => h.handleUpdate({ update_id: 1, message: { message_id: ++mid, chat: { id, type: 'private' }, from: { id, username: `u${id}` }, text, ...extra } });
  const cb = (id, data) => h.handleUpdate({ update_id: 1, callback_query: { id: 'q', from: { id, username: `u${id}` }, data, message: { chat: { id, type: 'private' } } } });
  return { cfg, db, tg, h, msg, cb, setNow: (x) => { t = x; } };
}

test('/start with a referral link registers the referral for NEW users only', async () => {
  const b = boot();
  await b.msg(1, '/start');
  const code = getUser(b.db, 1).ref_code;
  await b.msg(2, `/start ref_${code}`);
  assert.equal(getUser(b.db, 2).referred_by, '1');
  await b.msg(3, '/start'); await b.msg(3, `/start ref_${code}`);       // existing user can't be re-attributed
  assert.equal(getUser(b.db, 3).referred_by, null);
  await b.msg(1, `/start ref_${code}`);                                   // self
  assert.equal(getUser(b.db, 1).referred_by, null);
  assert.match(b.tg.texts()[0], /custodial/);
});

test('/referral shows a t.me deep link using the bot username', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/referral');
  assert.match(b.tg.last().args[1], new RegExp(`https://t\\.me/mintpilot_bot\\?start=ref_${getUser(b.db, 1).ref_code}`));
});

test('pasted private key / seed phrase is deleted and the user is warned', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.msg(1, '0x' + 'ab'.repeat(32), { message_id: 77 });
  assert.ok(b.tg.calls.some((c) => c.method === 'deleteMessage' && c.args[1] === 77));
  assert.match(b.tg.last().args[1], /compromised/);
  await b.msg(1, 'abandon ability able about above absent absorb abstract absurd abuse access accident', { message_id: 78 });
  assert.ok(b.tg.calls.some((c) => c.method === 'deleteMessage' && c.args[1] === 78));
});

test('/schedule is refused when automatic signing is not configured', async () => {
  const b = boot();
  b.cfg.automation.enabled = false;
  await b.msg(1, '/schedule');
  assert.match(b.tg.last().args[1], /Automatic minting is not available/);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM conversations').get().n, 0);
});

const platformWallet = (b, id) => b.db.prepare("SELECT address FROM wallets WHERE telegram_id=? AND wallet_type='platform'").get(String(id)).address;

async function runWizard(b, id, { qty = '2', price = '0.01', when = '+2h' } = {}) {
  await b.msg(id, '/schedule'); await b.cb(id, 'c:base');
  await b.msg(id, A(5)); await b.cb(id, 'p:1');
  await b.msg(id, qty); await b.msg(id, price); await b.cb(id, 'mode:manual'); await b.msg(id, when);
}

test('schedule wizard end-to-end creates an automatically signed schedule from the platform wallet', async () => {
  const b = boot(); await b.msg(1, '/start');
  await runWizard(b, 1);
  const confirm = b.tg.last().args[1];
  assert.match(confirm, /Confirm schedule/);
  assert.match(confirm, /0\.02 ETH/);
  assert.match(confirm, /signs and sends this mint automatically/);
  assert.doesNotMatch(confirm, /signing link/);
  await b.cb(1, 'ok');
  const row = b.db.prepare('SELECT * FROM schedules').get();
  assert.equal(row.chain, 'base'); assert.equal(row.contract, A(5)); assert.equal(row.quantity, 2);
  assert.equal(row.total_wei, (2n * 10n ** 16n).toString()); assert.equal(row.scheduled_at, T0 + 7200);
  assert.equal(row.wallet_address, platformWallet(b, 1));
  assert.match(b.tg.last().args[1], /Mint <b>#1<\/b> scheduled/);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM conversations').get().n, 0);
});

test('dry-run deployments say so on the confirmation screen', async () => {
  const b = boot(); b.cfg.automation.dryRun = true;
  await b.msg(1, '/start'); await runWizard(b, 1);
  assert.match(b.tg.last().args[1], /dry-run mode/);
});

test('wizard: only networks MintPilot may auto-sign on are offered; rejects non-contracts, bad input, and over-cap totals', async () => {
  const b = boot({ rpc: { hasCode: async (c, a) => a !== A(6) } }); await b.msg(1, '/start');
  await b.msg(1, '/schedule');
  const names = b.tg.last().args[2].reply_markup.inline_keyboard.flat().map((x) => x.text);
  assert.deepEqual(names, ['Ethereum', 'Base', 'Ink', 'Robinhood Chain', 'Arbitrum One', 'OP Mainnet', 'Zora', 'Shape', 'Unichain', 'Soneium', 'Cancel']);
  assert.ok(!names.some((n) => /sepolia|testnet|local/i.test(n)), 'no testnet is ever offered');
  b.cfg.automation.allowedChains = ['base', 'robinhood'];
  await b.msg(1, '/schedule');
  assert.deepEqual(b.tg.last().args[2].reply_markup.inline_keyboard.flat().map((x) => x.text), ['Base', 'Robinhood Chain', 'Cancel']);
  await b.cb(1, 'c:robinhood');
  await b.msg(1, 'not-an-address'); assert.match(b.tg.last().args[1], /Collection search is not enabled/);
  await b.msg(1, A(6)); assert.match(b.tg.last().args[1], /No contract code/);
  await b.msg(1, A(5)); await b.cb(1, 'p:1');
  await b.msg(1, '99'); assert.match(b.tg.last().args[1], /whole number/);
  await b.msg(1, '2');
  await b.msg(1, '0.9'); assert.match(b.tg.last().args[1], /safety cap/);
  await b.msg(1, '0.1'); await b.cb(1, 'mode:manual'); await b.msg(1, 'someday'); assert.match(b.tg.last().args[1], /Use a time like "5:10 pm"/);
});

test('launch mode for a generic contract asks for the opening time and stores it (review #2)', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.msg(1, '/schedule'); await b.cb(1, 'c:base'); await b.msg(1, A(5)); await b.cb(1, 'p:1');
  await b.msg(1, '1'); await b.msg(1, '0.01'); await b.cb(1, 'mode:launch');
  assert.match(b.tg.last().args[1], /When does the mint open/);
  await b.msg(1, '+3h');
  assert.match(b.tg.last().args[1], /As soon as it opens \(expected/);
  await b.cb(1, 'ok');
  const row = b.db.prepare('SELECT * FROM schedules').get();
  assert.equal(row.trigger_mode, 'launch');
  assert.equal(row.launch_at, T0 + 3 * 3600);
});

test('adapter JSON: file/URL sources and unknown fields are rejected without touching the server (review #1)', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.msg(1, '/schedule'); await b.cb(1, 'c:base'); await b.msg(1, A(5)); await b.cb(1, 'a:merkle');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintpilot-bot-'));
  const secret = path.join(dir, '.env');
  fs.writeFileSync(secret, 'TELEGRAM_BOT_TOKEN=do-not-leak');
  await b.msg(1, JSON.stringify({ signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, priceWei: '0', proofFile: secret }));
  assert.match(b.tg.last().args[1], /Unsupported field for the merkle adapter: proofFile/);
  assert.doesNotMatch(b.tg.last().args[1], /TELEGRAM|do-not-leak/);
  await b.msg(1, JSON.stringify({ signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, priceWei: '0', proofUrl: 'http://127.0.0.1:1/admin' }));
  assert.match(b.tg.last().args[1], /Unsupported field.*proofUrl/);
  await b.msg(1, JSON.stringify({ signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, priceWei: '0', providerId: 'nope' }));
  assert.match(b.tg.last().args[1], /provider "nope" is not configured/);
});

test('friendly OpenSea flow searches a collection name, offers quantity buttons, accepts an ETH cap, and schedules only after confirmation', async () => {
  const realFetch = globalThis.fetch;
  const contract = A(5);
  const drop = {
    collection_slug: 'example-drop', collection_name: 'Example Collection', chain: 'base',
    contract_address: contract, drop_type: 'seadrop_v1_erc721', fee_bps: 1000, is_minting: true,
    active_stage: {
      stage_type: 'public_sale', price: '10000000000000000',
      price_currency_address: '0x0000000000000000000000000000000000000000',
      start_time: new Date(T0 * 1000).toISOString(), end_time: new Date((T0 + 3600) * 1000).toISOString()
    }
  };
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v2/search') return new Response(JSON.stringify({ results: [
      { type: 'collection', collection: { collection: 'example-drop', name: 'Example Collection', is_disabled: false } }
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (parsed.pathname === '/api/v2/drops/example-drop') return new Response(JSON.stringify(drop), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`Unexpected OpenSea URL: ${url}`);
  };
  try {
    const b = boot(); b.cfg.openSeaApiKey = 'friendly-flow-test-key'; await b.msg(1, '/start');
    await b.msg(1, '/schedule'); await b.cb(1, 'c:base');
    assert.match(b.tg.last().args[1], /Send its name to search on OpenSea/);
    await b.msg(1, 'Example Collection');
    assert.match(b.tg.last().args[1], /Choose your collection/);
    await b.cb(1, 'osr:0');
    assert.match(b.tg.last().args[1], /Example Collection/);
    assert.ok(buttons(b.tg.last()).some((x) => x.callback_data === 'osq:2'));
    await b.cb(1, 'osq:2');
    assert.match(b.tg.last().args[1], /Maximum spend per NFT/);
    assert.ok(buttons(b.tg.last()).some((x) => x.callback_data === 'oscap:public'));
    await b.cb(1, 'oscap:public'); await b.cb(1, 'mode:manual'); await b.msg(1, '+2h');
    assert.match(b.tg.last().args[1], /Confirm schedule/);
    assert.match(b.tg.last().args[1], /0\.02 ETH/);
    assert.equal(b.db.prepare('SELECT COUNT(*) n FROM schedules').get().n, 0, 'a search never creates a schedule before confirmation');
    await b.cb(1, 'ok');
    const row = b.db.prepare('SELECT * FROM schedules').get();
    assert.equal(row.contract, contract); assert.equal(row.quantity, 2);
    assert.equal(row.total_wei, '20000000000000000');
    assert.deepEqual(Object.keys(JSON.parse(row.mint_spec)).sort(), ['adapter', 'feeBps', 'priceWei', 'quantity', 'slug']);
  } finally { globalThis.fetch = realFetch; }
});

test('friendly OpenSea flow refuses a known non-ETH public stage instead of presenting an ETH spend cap', async () => {
  const realFetch = globalThis.fetch;
  const contract = A(5);
  globalThis.fetch = async () => new Response(JSON.stringify({
    collection_slug: 'token-priced-drop', collection_name: 'Token Priced Drop', chain: 'base',
    contract_address: contract, drop_type: 'seadrop_v1_erc721', fee_bps: 1000, is_minting: true,
    active_stage: { stage_type: 'public_sale', price: '1000', price_currency_address: A(8) }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const b = boot(); b.cfg.openSeaApiKey = 'non-eth-stage-test-key'; await b.msg(1, '/start');
    await b.msg(1, '/schedule'); await b.cb(1, 'c:base');
    await b.msg(1, 'https://opensea.io/collection/token-priced-drop');
    assert.match(b.tg.last().args[1], /uses a token other than ETH/);
    assert.notEqual(convo(b).state, 'sched.osQty');
    assert.equal(b.db.prepare('SELECT COUNT(*) n FROM schedules').get().n, 0);
  } finally { globalThis.fetch = realFetch; }
});

test('legacy OpenSea JSON conversation is migrated to the collection prompt and never asks for JSON', async () => {
  const b = boot(); await b.msg(1, '/start');
  b.db.prepare('INSERT INTO conversations (telegram_id,state,data,updated_at) VALUES (?,?,?,?)')
    .run('1', 'sched.adapterConfig', JSON.stringify({ chain: 'base', contract: A(5), adapter: 'opensea-drop' }), T0);
  await b.msg(1, '{"slug":"example-drop","quantity":1,"priceWei":"10000000000000000"}');
  assert.equal(convo(b).state, 'sched.contract');
  assert.match(b.tg.last().args[1], /Find the collection/);
  assert.doesNotMatch(b.tg.last().args[1], /JSON object|priceWei|Send the OpenSea collection slug/);
});

test('an inline Merkle proof is scheduled for exactly one chosen wallet', async () => {
  const b = boot(); await b.msg(1, '/start');
  const { extendPremium } = require('../../src/core/users');
  extendPremium(b.db, 1, 30, T0);
  addWallet(b.db, b.cfg, 1, A(2));
  await b.msg(1, '/schedule'); await b.cb(1, 'c:base'); await b.msg(1, A(5)); await b.cb(1, 'a:merkle');
  await b.msg(1, JSON.stringify({ signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, priceWei: '0', proof: ['0x' + 'aa'.repeat(32)] }));
  await b.cb(1, 'mode:manual'); await b.msg(1, '+2h');
  assert.match(b.tg.last().args[1], /valid for one wallet only/);
  const second = b.db.prepare('SELECT id FROM wallets WHERE address=?').get(A(2)).id;
  await b.cb(1, `w1:${second}`);
  assert.match(b.tg.last().args[1], /Wallets \(1\)/);
  await b.cb(1, 'ok');
  const rows = b.db.prepare('SELECT wallet_address, mint_spec FROM schedules').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wallet_address, A(2));
  assert.deepEqual(Object.keys(JSON.parse(rows[0].mint_spec)).sort(), ['adapter', 'priceWei', 'proof', 'quantity', 'signatureFunction']);
});

test('free plan blocks the 4th active schedule; /cancel aborts a wizard', async () => {
  const b = boot(); await b.msg(1, '/start');
  for (let i = 0; i < 3; i++) { await runWizard(b, 1); await b.cb(1, 'ok'); }
  await runWizard(b, 1); await b.cb(1, 'ok');
  assert.match(b.tg.last().args[1], /free plan allows 3/);
  await b.msg(1, '/schedule'); await b.msg(1, '/cancel');
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM conversations').get().n, 0);
});

test('a user cannot cancel someone else\'s schedule via callback data', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(2, '/start');
  await runWizard(b, 1); await b.cb(1, 'ok');
  await b.cb(2, 'xy:1');
  assert.match(b.tg.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1).args[1], /Could not cancel/);
  assert.equal(b.db.prepare('SELECT status FROM schedules WHERE id=1').get().status, 'scheduled');
  await b.cb(1, 'xy:1');
  assert.equal(b.db.prepare('SELECT status FROM schedules WHERE id=1').get().status, 'cancelled');
});

test('/connect is retired and directs users to the generated wallet', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/connect');
  assert.match(b.tg.last().args[1], /no longer available/);
  assert.match(b.tg.last().args[1], /\/wallets/);
});

test('/track validates network + hash and enforces plan limits', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.msg(1, '/track base 0x12'); assert.match(b.tg.last().args[1], /Usage/);
  await b.msg(1, '/track solana ' + '0x' + 'a'.repeat(64)); assert.match(b.tg.last().args[1], /Usage/);
  await b.msg(1, '/track robinhood 0x' + 'a'.repeat(64)); assert.match(b.tg.last().args[1], /Tracking on Robinhood Chain/);
  await b.msg(1, '/track robinhood 0x' + 'a'.repeat(64)); assert.match(b.tg.last().args[1], /Already tracking/);
});

test('/check reports whether an address is already in the eligibility file', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mintpilot-bot-')), 'eligible.json');
  fs.writeFileSync(file, JSON.stringify({ addresses: [A(8)] }));
  const b = boot({ cfg: makeCfg({ eligibilityFile: file }) });
  await b.msg(1, `/check ${A(8)}`); assert.match(b.tg.last().args[1], /eligible to mint/);
  await b.msg(1, `/check ${A(9)}`); assert.match(b.tg.last().args[1], /not listed/);
  await b.msg(1, '/check not-an-address'); assert.match(b.tg.last().args[1], /valid EVM address/);
});

test('admin commands: only admins can grant/revoke/stats', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(999, '/start');
  const before = b.tg.calls.length;
  await b.msg(1, '/grant 1 30'); await b.msg(1, '/stats');
  assert.equal(getUser(b.db, 1).premium_until, 0);
  assert.equal(b.tg.calls.length, before);                        // silent for non-admins
  await b.msg(999, '/grant 1 30');
  assert.equal(getUser(b.db, 1).premium_until, T0 + 30 * 86400);
  await b.msg(999, '/revoke 1'); assert.equal(getUser(b.db, 1).premium_until, 0);
  await b.msg(999, '/stats'); assert.match(b.tg.last().args[1], /Users: 2/);
});

test('premium purchase with Stars: invoice → pre-checkout → payment grants premium exactly once', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/premium');
  const inv = b.tg.calls.find((c) => c.method === 'sendInvoice').args[1];
  assert.equal(inv.currency, 'XTR'); assert.equal(inv.prices[0].amount, b.cfg.premium.priceStars);
  assert.equal(inv.payload, payloadFor(1, b.cfg.premium.days));

  await b.h.handleUpdate({ update_id: 2, pre_checkout_query: { id: 'pc1', from: { id: 1 }, invoice_payload: inv.payload, currency: 'XTR', total_amount: inv.prices[0].amount } });
  assert.deepEqual(b.tg.calls.find((c) => c.method === 'answerPreCheckoutQuery').args.slice(1, 2), [true]);
  await b.h.handleUpdate({ update_id: 3, pre_checkout_query: { id: 'pc2', from: { id: 1 }, invoice_payload: inv.payload, currency: 'XTR', total_amount: 1 } });
  assert.equal(b.tg.calls.filter((c) => c.method === 'answerPreCheckoutQuery').at(-1).args[1], false);

  const pay = { update_id: 4, message: { message_id: 9, chat: { id: 1, type: 'private' }, from: { id: 1 }, successful_payment: { invoice_payload: inv.payload, currency: 'XTR', total_amount: inv.prices[0].amount, telegram_payment_charge_id: 'c1' } } };
  await b.h.handleUpdate(pay); await b.h.handleUpdate(pay);
  assert.equal(getUser(b.db, 1).premium_until, T0 + b.cfg.premium.days * 86400);
  assert.equal(b.tg.texts().filter((x) => /Premium activated/.test(x)).length, 1);
});

test('ignores group chats and banned users; unknown command gets help hint', async () => {
  const b = boot();
  await b.h.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: -5, type: 'group' }, from: { id: 1 }, text: '/start' } });
  assert.equal(b.tg.calls.length, 0);
  await b.msg(2, '/start'); b.db.prepare('UPDATE users SET banned=1 WHERE telegram_id=2').run();
  const n = b.tg.calls.length; await b.msg(2, '/help'); assert.equal(b.tg.calls.length, n);
  await b.msg(1, '/start'); await b.msg(1, '/wat'); assert.match(b.tg.last().args[1], /Unknown command/);
});


test('/connect explains that external-owner linking is retired', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.msg(1, '/connect');
  assert.match(b.tg.last().args[1], /platform wallet/);
});

test('/deposit is retired and does not expose old Smart Account controls', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.msg(1, '/deposit');
  assert.match(b.tg.last().args[1], /no longer available/);
  assert.doesNotMatch(b.tg.last().args[1], /smart account|automatic conversion/i);
});

test('/wallets: every registry network is queried in one parallel call per wallet; funded networks shown, failures named', async () => {
  const seen = [];
  const b = boot({ rpc: { hasCode: async () => true, getBalances: async (address, keys) => { seen.push(keys); return Object.fromEntries(keys.map((k) => [k, k === 'zora' ? '2500000000000000' : (k === 'shape' ? null : '0')])); } } });
  await b.msg(1, '/start');
  await b.msg(1, '/wallets');
  const text = b.tg.last().args[1];
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 10);
  assert.match(text, /Zora: <b>0\.0025 ETH<\/b>/);
  assert.match(text, /Balance unavailable right now on: Shape/);
  assert.doesNotMatch(text, /Sepolia|testnet/i);
});

test('wizard: a thirdweb drop is detected, its live public phase is scheduled at the on-chain price and start, allowlist phases are refused', async () => {
  const tw = require('../../src/core/adapters/thirdweb');
  const phase = (id, over = {}) => ({ id, startTimestamp: T0 + 600, maxClaimableSupply: '100', supplyClaimed: '0', quantityLimitPerWallet: '2', allowlist: false, pricePerToken: '1000000000000000', currency: tw.NATIVE, nativePrice: true, ...over });
  const discovery = { address: A(7), hasCode: true, nft: true, standards: { erc721: true }, protocol: 'thirdweb-drop', mintMethods: [], verifiedAbi: false,
    thirdwebDrop: { standard: 'erc721', variant: 'multi-phase', tokenId: null, needsTokenId: false, phases: [phase(0, { allowlist: true, startTimestamp: T0 + 300 }), phase(1), phase(2, { startTimestamp: T0 + 9000 })] } };
  const b = boot({ rpc: { hasCode: async () => true, discover: async () => discovery } });
  await b.msg(1, '/start'); // provisions the custodial platform wallet
  await b.msg(1, '/schedule'); await b.cb(1, 'c:base'); await b.msg(1, A(7));
  const buttons = b.tg.last().args[2].reply_markup.inline_keyboard.flat().map((x) => x.callback_data);
  assert.deepEqual(buttons, ['tw:0', 'tw:1', 'tw:2', 'tw:other', 'wz:b:sched.preset', 'wz:x']);
  await b.cb(1, 'tw:0');
  assert.match(b.tg.last().args[1], /allowlist-only/);
  await b.cb(1, 'tw:1');
  assert.match(b.tg.last().args[1], /Wallet limit: <b>2<\/b>/);
  await b.msg(1, '3');
  assert.match(b.tg.last().args[1], /at most 2 per wallet/);
  await b.msg(1, '2');
  await b.cb(1, 'mode:launch');
  assert.match(b.tg.last().args[1], /thirdweb phase: <b>1<\/b>/);
  assert.match(b.tg.last().args[1], /0\.002 ETH/);
  await b.cb(1, 'ok');
  const row = b.db.prepare('SELECT * FROM schedules').get();
  assert.equal(row.preset, 'adapter:thirdweb-drop');
  assert.equal(row.launch_at, T0 + 600, 'launch time read from the contract phase');
  assert.equal(row.end_at, T0 + 9000, 'window closes when the next phase starts');
  assert.equal(row.total_wei, '2000000000000000');
  assert.equal(JSON.parse(row.mint_spec).pricePerToken, '1000000000000000');
});

// ───────── simplified bot interface ─────────
const rpcOk = { hasCode: async () => true, getBalances: async (address, keys) => Object.fromEntries(keys.map((k) => [k, "0"])) };
const buttons = (m) => (m.args[2]?.reply_markup?.inline_keyboard || []).flat();
const callbacks = (m) => buttons(m).map((x) => x.callback_data);

test('the Telegram command menu lists seven commands and every one is handled', async () => {
  assert.deepEqual(COMMANDS.map((c) => c.command), ['start', 'schedule', 'mints', 'wallets', 'dashboard', 'summary', 'timezone', 'support', 'help']);
  const b = boot({ rpc: rpcOk });
  for (const c of COMMANDS) { await b.msg(1, `/${c.command}`); assert.doesNotMatch(b.tg.last().args[1], /Unknown command/, c.command); }
});

test('/start is a short welcome with the wallet address and a six-button menu', async () => {
  const b = boot(); await b.msg(1, '/start');
  const m = b.tg.last(); const address = b.db.prepare('SELECT address FROM wallets WHERE telegram_id=1').get().address;
  assert.ok(m.args[1].includes(address));
  assert.match(m.args[1], /Schedule a mint/);
  assert.match(m.args[1], /custodial/);
  assert.ok(m.args[1].split('\n').filter(Boolean).length <= 12, 'welcome stays short');
  assert.deepEqual(callbacks(m), ['m:schedule', 'm:list', 'm:wallets', 'm:dashboard', 'm:plan', 'm:tz', 'm:help']);
});

test('/mints and the older /myschedules show the same list, with Check and Cancel on each open mint', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.msg(1, '/mints'); assert.match(b.tg.last().args[1], /No mints scheduled yet/);
  await runWizard(b, 1); await b.cb(1, 'ok');
  await b.msg(1, '/mints'); const a = b.tg.last();
  await b.msg(1, '/myschedules'); const old = b.tg.last();
  assert.match(a.args[1], /<b>Mint #1<\/b> · Scheduled/);
  assert.equal(a.args[1], old.args[1]);
  assert.deepEqual(callbacks(a), ['r:1', 'x:1', 'm:home']);
  await b.cb(1, 'm:list'); assert.equal(b.tg.last().args[1], a.args[1]);
});

test('/wallets: free users are pointed to Premium, Premium users get add-wallet buttons', async () => {
  const b = boot({ rpc: rpcOk }); await b.msg(1, '/start'); await b.msg(1, '/wallets');
  assert.match(b.tg.last().args[1], /Main wallet/);
  assert.deepEqual(callbacks(b.tg.last()), ['m:plan', 'm:home']);
  extendPremium(b.db, 1, 30, T0);
  await b.msg(1, '/wallets');
  assert.deepEqual(callbacks(b.tg.last()), ['m:wallet-create', 'm:wallet-import', 'm:home']);
  await b.cb(1, 'm:wallet'); assert.match(b.tg.last().args[1], /Your wallets/); // older button still works
});

test('the Plan button shows the plan, the invite link and an upgrade button that opens the invoice', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.cb(1, 'm:plan');
  const m = b.tg.last();
  assert.match(m.args[1], /Free/);
  assert.match(m.args[1], new RegExp(`start=ref_${getUser(b.db, 1).ref_code}`));
  assert.deepEqual(callbacks(m), ['m:upgrade', 'm:referral', 'm:home']);
  await b.cb(1, 'm:upgrade');
  assert.ok(b.tg.calls.some((c) => c.method === 'sendInvoice'));
});

test('the Help button answers, and the older hidden commands keep working', async () => {
  const b = boot({ rpc: rpcOk }); await b.msg(1, '/start');
  await b.cb(1, 'm:help'); assert.match(b.tg.last().args[1], /How MintPilot works/);
  await b.msg(1, '/help'); assert.match(b.tg.last().args[1], /\/mints/);
  for (const c of ['/plans', '/premium', '/referral', '/wallet', '/myschedules']) {
    await b.msg(1, c); assert.doesNotMatch(b.tg.last().args[1] || '', /Unknown command/, c);
  }
});

test('retired commands answer in one line and show the menu', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/policy');
  assert.match(b.tg.last().args[1], /no longer available/);
  assert.equal(callbacks(b.tg.last()).length, 6);
});

test("the timing step offers \"At a set time\" and \"As soon as it opens\"", async () => {
  const b = boot(); await b.msg(1, "/start"); await runWizard(b, 1);
  // every screen the wizard showed, whether it was sent or edited into the pane
  const screens = b.tg.calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText")
    .map((c) => (c.method === "sendMessage" ? { text: c.args[1], extra: c.args[2] } : { text: c.args[2], extra: c.args[3] }));
  const keys = (x) => (x.extra?.reply_markup?.inline_keyboard || []).flat();
  const step = screens.find((x) => keys(x).some((k) => k.callback_data === "mode:manual"));
  assert.ok(step, "the timing step was shown");
  assert.deepEqual(keys(step).map((x) => x.text), ["At a set time", "As soon as it opens", "‹ Back", "Cancel"]);
  assert.match(step.text, /When should MintPilot mint\?/);
  assert.match(screens.map((x) => x.text).join("\n"), /Which network is the NFT on\?/);
});

test('example times in prompts are always in the future (no stale hardcoded dates)', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.msg(1, '/schedule'); await b.cb(1, 'c:base'); await b.msg(1, A(5)); await b.cb(1, 'p:1');
  await b.msg(1, '2'); await b.msg(1, '0.01'); await b.cb(1, 'mode:manual');
  const example = b.tg.last().args[1].match(/<code>(\d{4}-\d{2}-\d{2} \d{2}:\d{2})<\/code>/)[1];
  await b.msg(1, example);                                   // copying the example must be accepted
  assert.match(b.tg.last().args[1], /Confirm schedule/);
});

test('removing a wallet needs a confirmation tap; "Keep it" removes nothing', async () => {
  const b = boot(); await b.msg(1, '/start');
  extendPremium(b.db, 1, 30, T0); addWallet(b.db, b.cfg, 1, A(9));
  const before = b.db.prepare('SELECT COUNT(*) n FROM wallets WHERE telegram_id=?').get('1').n;
  const id = b.db.prepare('SELECT id FROM wallets WHERE address=?').get(A(9)).id;
  await b.cb(1, `rm:${id}`);
  assert.match(b.tg.last().args[1], /cannot be undone/);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM wallets WHERE telegram_id=?').get('1').n, before);
  await b.cb(1, 'rmn');
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM wallets WHERE telegram_id=?').get('1').n, before);
  await b.cb(1, `rmy:${id}`);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM wallets WHERE telegram_id=?').get('1').n, before - 1);
});

test('the main wallet cannot be removed through a crafted button', async () => {
  const b = boot(); await b.msg(1, '/start');
  const id = b.db.prepare("SELECT id FROM wallets WHERE wallet_type='platform'").get().id;
  await b.cb(1, `rm:${id}`); await b.cb(1, `rmy:${id}`);
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM wallets WHERE wallet_type='platform'").get().n, 1);
});

// ───────── wizard UI: edit in place, Back / Cancel, time quick-picks ─────────
const cbm = (b, id, data, mid) => b.h.handleUpdate({ update_id: 1, callback_query: { id: 'q', from: { id, username: `u${id}` }, data, message: { message_id: mid, chat: { id, type: 'private' } } } });
const edits = (b) => b.tg.calls.filter((c) => c.method === 'editMessageText');
const convo = (b) => { const r = b.db.prepare('SELECT state, data FROM conversations').get(); return r ? { state: r.state, data: JSON.parse(r.data) } : null; };
const toStep = async (b, id, upTo) => {
  await b.msg(id, '/schedule'); await b.cb(id, 'c:base');
  if (upTo === 'contract') return;
  await b.msg(id, A(5)); await b.cb(id, 'p:1');
  if (upTo === 'qty') return;
  await b.msg(id, '2'); await b.msg(id, '0.01'); await b.cb(id, 'mode:manual');
};

test('a button press edits the tapped message instead of sending a new one', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/schedule');
  const sent = b.tg.calls.filter((c) => c.method === 'sendMessage').length;
  await cbm(b, 1, 'c:base', 55);
  assert.equal(edits(b).length, 1);
  assert.equal(edits(b)[0].args[0], 1); assert.equal(edits(b)[0].args[1], 55);
  assert.match(edits(b)[0].args[2], /NFT contract address/);
  assert.equal(b.tg.calls.filter((c) => c.method === 'sendMessage').length, sent, 'no extra message was sent');
  assert.deepEqual(edits(b)[0].args[3].reply_markup.inline_keyboard.flat().map((x) => x.callback_data), ['wz:b:sched.contract', 'wz:x']);
});

test('if the message cannot be edited the screen is sent as a new message; "not modified" is not an error', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/schedule');
  b.tg.editMessageText = async () => { throw Object.assign(new Error('edit'), { description: 'Bad Request: message to edit not found' }); };
  await cbm(b, 1, 'c:base', 55);
  assert.match(b.tg.last().args[1], /NFT contract address/);
  const sent = b.tg.calls.filter((c) => c.method === 'sendMessage').length;
  b.tg.editMessageText = async () => { throw Object.assign(new Error('edit'), { description: 'Bad Request: message is not modified' }); };
  await cbm(b, 1, 'wz:b:sched.contract', 55);
  assert.equal(b.tg.calls.filter((c) => c.method === 'sendMessage').length, sent, 'nothing re-sent for an unchanged screen');
});

test('errors and rejections never replace the screen the user is on', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/schedule');
  await cbm(b, 1, 'c:base', 55);                                   // edit #1: the contract prompt
  await cbm(b, 1, 'p:1', 56);                                      // wrong step: expired notice
  assert.equal(edits(b).length, 1);
  assert.match(b.tg.last().args[1], /expired/);
});

test('Back walks the wizard one step at a time and Cancel ends it', async () => {
  const b = boot(); await b.msg(1, '/start');
  await toStep(b, 1, 'qty');
  assert.equal(convo(b).state, 'sched.qty');
  await b.cb(1, 'wz:b:sched.qty');                                  // quantity -> method list
  assert.equal(convo(b).state, 'sched.preset');
  assert.equal(convo(b).data.contract, A(5)); assert.equal(convo(b).data.preset, undefined);
  assert.match(b.tg.last().args[1], /Choose the mint method/);
  await b.cb(1, 'wz:b:sched.preset');                               // method list -> contract
  assert.equal(convo(b).state, 'sched.contract'); assert.equal(convo(b).data.contract, undefined);
  assert.match(b.tg.last().args[1], /NFT contract address/);
  await b.cb(1, 'wz:b:sched.contract');                             // contract -> network
  assert.equal(convo(b).state, 'sched.chain');
  assert.match(b.tg.last().args[1], /Which network/);
  assert.ok(!buttons(b.tg.last()).some((x) => x.callback_data.startsWith('wz:b:')), 'the first step has no Back');
  await b.cb(1, 'wz:b:sched.qty');                                  // a stale Back does nothing
  assert.match(b.tg.last().args[1], /expired/); assert.equal(convo(b).state, 'sched.chain');
  await b.cb(1, 'wz:x');
  assert.equal(convo(b), null); assert.match(b.tg.last().args[1], /Cancelled/);
});

test('Back from the confirmation returns to "when should MintPilot mint" and the wizard can be completed again', async () => {
  const b = boot(); await b.msg(1, '/start'); await runWizard(b, 1);
  assert.equal(convo(b).state, 'sched.confirm');
  await b.cb(1, 'wz:b:sched.confirm');
  assert.equal(convo(b).state, 'sched.mode'); assert.equal(convo(b).data.when, undefined);
  await b.cb(1, 'mode:manual'); await b.msg(1, '+3h');
  await b.cb(1, 'ok');
  assert.equal(b.db.prepare('SELECT scheduled_at FROM schedules').get().scheduled_at, T0 + 3 * 3600);
});

test('time quick-picks schedule without typing, and the confirmation shows a countdown', async () => {
  const b = boot(); await b.msg(1, '/start');
  await toStep(b, 1, 'when');
  assert.deepEqual(buttons(b.tg.last()).map((x) => x.callback_data), ['t:+10m', 't:+1h', 't:+6h', 't:tom', 'tz:menu', 'wz:b:sched.when', 'wz:x']);
  await b.cb(1, 't:now');                                           // "already open" only exists for launch mode
  assert.equal(convo(b).state, 'sched.when');
  await b.cb(1, 't:+1h');
  assert.match(b.tg.last().args[1], /Confirm schedule/); assert.match(b.tg.last().args[1], /\(in 1h\)/);
  await b.cb(1, 'ok');
  assert.equal(b.db.prepare('SELECT scheduled_at FROM schedules').get().scheduled_at, T0 + 3600);
});

test('the "Tomorrow 18:00 UTC" quick-pick lands on 18:00 UTC of the next day', async () => {
  const b = boot(); await b.msg(1, '/start'); await toStep(b, 1, 'when');
  await b.cb(1, 't:tom'); await b.cb(1, 'ok');
  const at = b.db.prepare('SELECT scheduled_at FROM schedules').get().scheduled_at;
  const d = new Date(at * 1000);
  assert.equal(d.getUTCHours(), 18); assert.equal(d.getUTCMinutes(), 0);
  assert.ok(at > T0 && at - T0 <= 2 * 86400);
});

test('launch mode: quick-pick "It is already open" starts the launch window now', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.msg(1, '/schedule'); await b.cb(1, 'c:base'); await b.msg(1, A(5)); await b.cb(1, 'p:1');
  await b.msg(1, '1'); await b.msg(1, '0.01'); await b.cb(1, 'mode:launch');
  assert.equal(convo(b).state, 'sched.launchAt');
  assert.ok(buttons(b.tg.last()).some((x) => x.callback_data === 't:now'));
  await b.cb(1, 't:now');
  assert.match(b.tg.last().args[1], /As soon as it opens/);
  assert.equal(convo(b).data.launchAt, T0);
});

test('cancelling a mint shows a toast and refreshes the list in place', async () => {
  const b = boot(); await b.msg(1, '/start'); await runWizard(b, 1); await b.cb(1, 'ok');
  await cbm(b, 1, 'xy:1', 77);
  const toast = b.tg.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
  assert.equal(toast.args[1], 'Mint #1 cancelled');
  assert.equal(edits(b).at(-1).args[1], 77);
  assert.match(edits(b).at(-1).args[2], /Cancelled/);
  assert.equal(b.db.prepare('SELECT status FROM schedules WHERE id=1').get().status, 'cancelled');
});

// ───────── typed clock times and whole-minute offsets ─────────
const at = (h, mi, sec = 0, day = 15) => Date.UTC(2027, 0, day, h, mi, sec) / 1000;

test('a typed time of day ("5:10 pm utc") is the next time the clock shows it', () => {
  const now = at(10, 20, 20);                                       // 10:20:20 UTC
  for (const text of ['5:10 pm', '5:10pm', '5:10 PM UTC', '5.10 pm', '17:10', '17:10 utc', '5:10 p.m.']) assert.equal(parseWhen(text, now), at(17, 10), text);
  assert.equal(parseWhen('5pm', now), at(17, 0));
  assert.equal(parseWhen('12:30 pm', now), at(12, 30));
  assert.equal(parseWhen('12 pm', now), at(12, 0));
  assert.equal(parseWhen('12 am', now), at(0, 0, 0, 16), 'midnight has passed today, so it is tomorrow\'s');
  assert.equal(parseWhen('9:05 am', now), at(9, 5, 0, 16), 'already passed today: tomorrow');
  assert.equal(parseWhen('9:05', at(9, 5, 0)), at(9, 5, 0, 16), 'exactly now counts as passed');
  assert.equal(parseWhen('2027-01-20 6:30 pm', now), at(18, 30, 0, 20));
  assert.equal(parseWhen('2027-01-20 18:30', now), at(18, 30, 0, 20));
});

test('a typed time of day is refused when it is invalid or less than 30 seconds away', () => {
  const now = at(10, 20, 20);
  for (const bad of ['13 pm', '0 pm', '5:75 pm', '25:00', '5', '5:10 xm', '5:10 pm cet', '5:10:30 pm']) assert.throws(() => parseWhen(bad, now), bad);
  assert.throws(() => parseWhen('10:20', at(10, 19, 50)), /30 seconds/);
  assert.equal(parseWhen('10:20', at(10, 19, 20)), at(10, 20));
});

test('offsets land on a whole minute: +10m at 10:20:20 is 10:30:00', () => {
  const now = at(10, 20, 20);
  assert.equal(parseWhen('+10m', now), at(10, 30, 0));
  assert.equal(parseWhen('+2h', now), at(12, 20, 0));
  assert.equal(parseWhen('+1d', now), at(10, 20, 0, 16));
  assert.equal(parseWhen('+1m', at(10, 20, 50)), at(10, 22, 0), 'rounding must not leave less than 30 seconds');
  assert.equal(parseWhen(String(at(12, 0, 7)), now), at(12, 0, 7), 'a unix timestamp stays exact, seconds included');
});

test('wizard: typing "5:10 pm utc" schedules exactly 17:10:00 UTC, and quick-picks land on whole minutes', async () => {
  const b = boot(); await b.msg(1, '/start');
  b.setNow(T0 + 20);                                                // 08:00:20 UTC, not on a minute
  await toStep(b, 1, 'when');
  await b.msg(1, '5:10 pm utc');
  assert.match(b.tg.last().args[1], /At 2027-01-15 17:10 UTC/);
  await b.cb(1, 'ok');
  assert.equal(b.db.prepare('SELECT scheduled_at FROM schedules').get().scheduled_at, at(17, 10));
  await b.msg(1, '/schedule'); await b.cb(1, 'c:base'); await b.msg(1, A(6)); await b.cb(1, 'p:1');
  await b.msg(1, '1'); await b.msg(1, '0.01'); await b.cb(1, 'mode:manual');
  await b.cb(1, 't:+10m');
  await b.cb(1, 'ok');
  const rows = b.db.prepare('SELECT scheduled_at FROM schedules ORDER BY id').all();
  assert.equal(rows[1].scheduled_at, T0 + 600, '08:00:20 + 10 min = 08:10:00');
});

test('the time prompts say the zone is UTC and show the current UTC time', async () => {
  const b = boot(); await b.msg(1, '/start');
  b.setNow(T0 + 20);                                                // 08:00:20 UTC
  await toStep(b, 1, 'when');
  assert.match(b.tg.last().args[1], /Times are in UTC\. It is now <b>2027-01-15 08:00 UTC<\/b>/);
  assert.ok(buttons(b.tg.last()).some((x) => x.text === 'Tomorrow 18:00 UTC'));
  await b.cb(1, 'wz:b:sched.when'); await b.cb(1, 'mode:launch');
  assert.match(b.tg.last().args[1], /It is now <b>2027-01-15 08:00 UTC<\/b>/);
});

// ───────── single-pane wizard: one message, typed answers removed, mistakes shown inside it ─────────
const sendsOf = (b) => b.tg.calls.filter((c) => c.method === 'sendMessage');
const deletesOf = (b) => b.tg.calls.filter((c) => c.method === 'deleteMessage');
const keysOf = (extra) => (extra?.reply_markup?.inline_keyboard || []).flat().map((x) => x.callback_data);

test('the whole wizard happens in one message that is edited from step to step', async () => {
  const b = boot(); await b.msg(1, '/start');
  const before = sendsOf(b).length;
  await runWizard(b, 1); await b.cb(1, 'ok');
  assert.equal(sendsOf(b).length - before, 1, 'one message for the entire wizard');
  assert.equal(new Set(edits(b).map((c) => c.args[1])).size, 1, 'every step edited that same message');
  assert.match(edits(b).at(-1).args[2], /✅ Mint <b>#1<\/b> scheduled/);
  assert.deepEqual(keysOf(edits(b).at(-1).args[3]), ['m:list', 'm:home']);
  assert.equal(deletesOf(b).length, 4, 'contract, quantity, price and time answers were deleted once read');
});

test('a typed answer is read, deleted, and the pane moves on', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/schedule'); await b.cb(1, 'c:base');
  const sent = sendsOf(b).length;
  await b.msg(1, A(5));
  assert.equal(sendsOf(b).length, sent, 'no new message');
  assert.match(edits(b).at(-1).args[2], /Choose the mint method/);
  assert.equal(deletesOf(b).length, 1); assert.equal(deletesOf(b)[0].args[0], 1);
});

test('a mistake appears at the top of the pane, keeps its buttons, and disappears with the next valid answer', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/schedule'); await b.cb(1, 'c:base');
  const sent = sendsOf(b).length;
  await b.msg(1, 'not an address');
  assert.equal(sendsOf(b).length, sent, 'the error was not sent as a separate message');
  const e = edits(b).at(-1);
  assert.match(e.args[2], /^⚠️ /); assert.match(e.args[2], /NFT contract address/);
  assert.deepEqual(keysOf(e.args[3]), ['wz:b:sched.contract', 'wz:x']);
  await b.msg(1, 'still not one');                                   // repeated mistakes do not stack warnings
  assert.equal((edits(b).at(-1).args[2].match(/⚠️/g) || []).length, 1);
  await b.msg(1, A(5));
  assert.doesNotMatch(edits(b).at(-1).args[2], /⚠️/);
  assert.match(edits(b).at(-1).args[2], /Choose the mint method/);
});

test('the contract inspection is part of the method screen, not a separate message', async () => {
  const discovery = { address: A(7), hasCode: true, nft: true, name: 'Cool Cats', symbol: 'COOL', standards: { erc721: true }, protocol: 'unknown', mintMethods: [], verifiedAbi: false };
  const b = boot({ rpc: { hasCode: async () => true, discover: async () => discovery } });
  await b.msg(1, '/start'); await b.msg(1, '/schedule'); await b.cb(1, 'c:base');
  const sent = sendsOf(b).length;
  await b.msg(1, A(7));
  assert.equal(sendsOf(b).length, sent);
  const text = edits(b).at(-1).args[2];
  assert.match(text, /Contract inspection/); assert.match(text, /Cool Cats/); assert.match(text, /Choose the mint method/);
});

test('/cancel closes the pane instead of leaving stale buttons; with nothing open it says so', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/schedule'); await b.cb(1, 'c:base');
  const sent = sendsOf(b).length;
  await b.msg(1, '/cancel');
  assert.equal(sendsOf(b).length, sent);
  assert.match(edits(b).at(-1).args[2], /<i>Cancelled\.<\/i>/);
  assert.ok(keysOf(edits(b).at(-1).args[3]).includes('m:schedule'), 'the main menu is offered');
  assert.equal(convo(b), null);
  await b.msg(1, '/cancel');
  assert.match(b.tg.last().args[1], /Nothing to cancel/);
});

test('another command or a new /schedule closes the old pane', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/schedule'); await b.cb(1, 'c:base');
  await b.msg(1, '/help');
  assert.match(edits(b).at(-1).args[2], /<i>Cancelled\.<\/i>/); assert.equal(edits(b).at(-1).args[3], undefined, 'no stale buttons');
  assert.match(b.tg.last().args[1], /How MintPilot works/);
  await b.msg(1, '/schedule'); await b.cb(1, 'c:base');
  const sent = sendsOf(b).length; const closed = edits(b).length;
  await b.msg(1, '/schedule');
  assert.equal(sendsOf(b).length, sent + 1, 'a new run gets its own message');
  assert.match(edits(b)[closed].args[2], /<i>Cancelled\.<\/i>/, 'and the old one is closed');
});

test('after the wizard ends the pane is forgotten: later messages are not edited into the receipt', async () => {
  const b = boot(); await b.msg(1, '/start'); await runWizard(b, 1); await b.cb(1, 'ok');
  const e = edits(b).length; const sent = sendsOf(b).length;
  await b.msg(1, 'hello there');
  assert.equal(edits(b).length, e); assert.equal(sendsOf(b).length, sent + 1);
  assert.match(b.tg.last().args[1], /Use the menu/);
});

test('after a restart the wizard carries on in a fresh message', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/schedule'); await b.cb(1, 'c:base');
  const h2 = createBotHandlers({ tg: b.tg, db: b.db, cfg: b.cfg, chains: getChains(b.cfg), rpc: { hasCode: async () => true }, now: () => T0, botUsername: 'x', limiter: createLimiter({ limit: 1000, windowSec: 60 }), log: silent });
  const sent = sendsOf(b).length;
  await h2.handleUpdate({ update_id: 9, message: { message_id: 999, chat: { id: 1, type: 'private' }, from: { id: 1, username: 'u1' }, text: A(5) } });
  assert.equal(sendsOf(b).length, sent + 1);
  assert.match(b.tg.last().args[1], /Choose the mint method/);
});

// ───────── home screen: every menu tap edits the same message, "‹ Menu" brings it home ─────────
test('a menu tap edits the tapped message, shows "Loading…" while balances load, and offers "‹ Menu"', async () => {
  const b = boot({ rpc: { hasCode: async () => true, getBalance: async () => null } }); await b.msg(1, '/start');
  const sent = sendsOf(b).length;
  await cbm(b, 1, 'm:wallets', 41);
  assert.equal(sendsOf(b).length, sent, 'no new message');
  assert.ok(edits(b).every((c) => c.args[1] === 41));
  assert.match(edits(b)[0].args[2], /Loading your wallets/);
  assert.equal(edits(b)[0].args[3], undefined, 'no buttons while loading');
  assert.match(edits(b).at(-1).args[2], /Your wallets/);
  assert.ok(keysOf(edits(b).at(-1).args[3]).includes('m:home'));
});

test('"‹ Menu" turns any screen back into the home screen in place', async () => {
  const b = boot(); await b.msg(1, '/start');
  await cbm(b, 1, 'm:plan', 41);
  assert.match(edits(b).at(-1).args[2], /Plans/);
  await cbm(b, 1, 'm:home', 41);
  assert.match(edits(b).at(-1).args[2], /Welcome to MintPilot/);
  assert.deepEqual(keysOf(edits(b).at(-1).args[3]), ['m:schedule', 'm:list', 'm:wallets', 'm:dashboard', 'm:plan', 'm:tz', 'm:help']);
});

test('the whole bot can be used from one message: the menu, every screen and the wizard', async () => {
  const b = boot({ rpc: { hasCode: async () => true, getBalance: async () => null } }); await b.msg(1, '/start');
  const sent = sendsOf(b).length;
  for (const data of ['m:wallets', 'm:home', 'm:list', 'm:home', 'm:plan', 'm:home', 'm:schedule']) await cbm(b, 1, data, 41);
  await cbm(b, 1, 'c:base', 41); await b.msg(1, A(5));            // typed answers edit the same message
  await cbm(b, 1, 'wz:x', 41);
  assert.equal(sendsOf(b).length, sent, 'nothing but the original home message was ever sent');
  assert.ok(edits(b).every((c) => c.args[1] === 41 || c.args[1] === edits(b)[0].args[1]));
  assert.match(edits(b).at(-1).args[2], /Cancelled/);
  assert.ok(keysOf(edits(b).at(-1).args[3]).includes('m:schedule'), 'cancelling returns to the menu');
});

test('starting the wizard from the menu uses that same message as its pane', async () => {
  const b = boot(); await b.msg(1, '/start');
  await cbm(b, 1, 'm:schedule', 41); await cbm(b, 1, 'c:base', 41);
  const sent = sendsOf(b).length;
  await b.msg(1, A(5));                                             // typed answer: edits message 41, not a new one
  assert.equal(sendsOf(b).length, sent);
  assert.equal(edits(b).at(-1).args[1], 41);
  assert.match(edits(b).at(-1).args[2], /Choose the mint method/);
});

test('tapping "Schedule a mint" on a second message closes the first wizard message', async () => {
  const b = boot(); await b.msg(1, '/start');
  await cbm(b, 1, 'm:schedule', 41);
  await cbm(b, 1, 'm:schedule', 99);
  const closed = edits(b).find((c) => c.args[1] === 41 && /<i>Cancelled\.<\/i>/.test(c.args[2]));
  assert.ok(closed, 'the old wizard message was closed');
  assert.match(edits(b).at(-1).args[2], /Schedule a mint/); assert.equal(edits(b).at(-1).args[1], 99);
});

test('/mints is paged: five per page, newer and older buttons, out-of-range pages are clamped', async () => {
  const b = boot(); await b.msg(1, '/start'); extendPremium(b.db, 1, 30, T0);
  for (let i = 0; i < 7; i += 1) { await runWizard(b, 1); await b.cb(1, 'ok'); }
  await b.msg(1, '/mints');
  let m = b.tg.last();
  assert.match(m.args[1], /Page 1 of 2/); assert.equal((m.args[1].match(/<b>Mint #/g) || []).length, 5);
  assert.deepEqual(callbacks(m).filter((c) => c.startsWith('m:list:')), ['m:list:1']);
  await b.cb(1, 'm:list:1'); m = b.tg.last();
  assert.match(m.args[1], /Page 2 of 2/); assert.equal((m.args[1].match(/<b>Mint #/g) || []).length, 2);
  assert.deepEqual(callbacks(m).filter((c) => c.startsWith('m:list:')), ['m:list:0']);
  await b.cb(1, 'm:list:99'); assert.match(b.tg.last().args[1], /Page 2 of 2/);
  await b.cb(1, 'm:list:abc'); assert.match(b.tg.last().args[1], /Page 1 of 2/);
});

// ───────── balance check on the confirm screen ─────────
const bootWithBalance = (initial, extra = {}) => {
  const state = { bal: initial };
  const b = boot({ rpc: { hasCode: async () => true, getBalance: async () => { if (state.bal instanceof Error) throw state.bal; if (state.bal === 'hang') return new Promise(() => {}); return state.bal; } }, ...extra });
  return { b, state };
};

test('confirm: a wallet that covers the mint total gets a green balance line', async () => {
  const { b } = bootWithBalance('1000000000000000000');
  await b.msg(1, '/start'); await runWizard(b, 1);
  const text = b.tg.last().args[1];
  assert.match(text, /Balance: <b>1 ETH<\/b> ✅/);
  assert.doesNotMatch(text, /Not enough/);
  assert.ok(!callbacks(b.tg.last()).includes('cf:refresh'));
});

test('confirm: a wallet below the mint total is warned, with a refresh button, and can still be saved', async () => {
  const { b, state } = bootWithBalance('1');
  await b.msg(1, '/start'); await runWizard(b, 1);
  const text = b.tg.last().args[1];
  assert.match(text, /Not enough ETH on Base/); assert.match(text, /has <b>0\.000000000000000001 ETH<\/b>, needs at least/);
  assert.ok(callbacks(b.tg.last()).includes('cf:refresh'));
  state.bal = '1000000000000000000';                                // the user funds the wallet
  await b.cb(1, 'cf:refresh');
  assert.match(b.tg.last().args[1], /Balance: <b>1 ETH<\/b> ✅/);
  assert.ok(!callbacks(b.tg.last()).includes('cf:refresh'));
  state.bal = '0';                                                  // saving is allowed even when short
  await b.cb(1, 'cf:refresh'); await b.cb(1, 'ok');
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM schedules').get().n, 1);
});

test('confirm: a free mint still needs a little ETH for the network fee', async () => {
  const { b, state } = bootWithBalance('0');
  await b.msg(1, '/start'); await runWizard(b, 1, { price: '0' });
  assert.match(b.tg.last().args[1], /needs a little ETH for the network fee/);
  state.bal = '5000000000000000';
  await b.cb(1, 'cf:refresh');
  assert.match(b.tg.last().args[1], /Balance: <b>0\.005 ETH<\/b> ✅/);
});

test('confirm: a failed or slow balance lookup adds nothing and never blocks the screen', async () => {
  const failing = bootWithBalance(new Error('rpc down'));
  await failing.b.msg(1, '/start'); await runWizard(failing.b, 1);
  assert.match(failing.b.tg.last().args[1], /Confirm schedule/);
  assert.doesNotMatch(failing.b.tg.last().args[1], /Balance:|Not enough/);
  const slow = bootWithBalance('hang', { balanceCheckMs: 20 });
  await slow.b.msg(1, '/start'); await runWizard(slow.b, 1);
  assert.match(slow.b.tg.last().args[1], /Confirm schedule/);
  assert.doesNotMatch(slow.b.tg.last().args[1], /Balance:|Not enough/);
});

test('a stale "check balance again" button does nothing outside the confirmation step', async () => {
  const { b } = bootWithBalance('1');
  await b.msg(1, '/start'); await runWizard(b, 1);
  await b.cb(1, 'wz:b:sched.confirm');                               // back to the timing step
  const state = convo(b).state;
  await b.cb(1, 'cf:refresh');
  assert.equal(convo(b).state, state);
});

// ───────── cancelling a mint asks first ─────────
test('Cancel on a mint asks first and changes nothing until it is confirmed', async () => {
  const b = boot(); await b.msg(1, '/start'); await runWizard(b, 1); await b.cb(1, 'ok');
  await b.cb(1, 'x:1');
  const ask = b.tg.last();
  assert.match(ask.args[1], /Cancel mint #1\?/); assert.match(ask.args[1], /NFT contract: <code>/); assert.match(ask.args[1], /When: .* UTC/);
  assert.deepEqual(callbacks(ask), ['xy:1', 'm:list']);
  assert.equal(b.db.prepare('SELECT status FROM schedules WHERE id=1').get().status, 'scheduled');
  await b.cb(1, 'm:list');                                           // "Keep it" goes back to the list, mint untouched
  assert.match(b.tg.last().args[1], /Mint #1<\/b> · Scheduled/);
  assert.equal(b.db.prepare('SELECT status FROM schedules WHERE id=1').get().status, 'scheduled');
  await b.cb(1, 'x:1'); await b.cb(1, 'xy:1');
  assert.equal(b.db.prepare('SELECT status FROM schedules WHERE id=1').get().status, 'cancelled');
});

test('the confirmation card replaces the list in place and the answer refreshes it', async () => {
  const b = boot(); await b.msg(1, '/start'); await runWizard(b, 1); await b.cb(1, 'ok');
  const sent = sendsOf(b).length;
  await cbm(b, 1, 'x:1', 77);
  assert.equal(sendsOf(b).length, sent); assert.equal(edits(b).at(-1).args[1], 77);
  assert.match(edits(b).at(-1).args[2], /Cancel mint #1\?/);
  await cbm(b, 1, 'xy:1', 77);
  assert.equal(b.tg.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1).args[1], 'Mint #1 cancelled');
  assert.match(edits(b).at(-1).args[2], /Cancelled/);
});

test('asking to cancel a mint that is finished, missing or someone else\'s just shows the current list', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(2, '/start'); await runWizard(b, 1); await b.cb(1, 'ok');
  await b.cb(2, 'x:1');                                              // not user 2's mint: nothing about it is revealed
  assert.doesNotMatch(b.tg.last().args[1], /Cancel mint #1|NFT contract/);
  await b.cb(1, 'xy:1');                                             // cancelled now
  await b.cb(1, 'x:1');                                              // no longer cancellable
  assert.doesNotMatch(b.tg.last().args[1], /Cancel mint #1\?/);
  await b.cb(1, 'x:999'); assert.doesNotMatch(b.tg.last().args[1], /Cancel mint #999\?/);
});

// ───────── time zone ─────────
const tzOfUser = (b, id) => b.db.prepare('SELECT timezone FROM users WHERE telegram_id=?').get(String(id)).timezone;

test('the Time zone button and /timezone open a picker with the current zone marked and a way home', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.cb(1, 'm:tz');
  const p = b.tg.last();
  assert.match(p.args[1], /Time zone/); assert.match(p.args[1], /\(the default\)/);
  const cbs = callbacks(p);
  for (const z of ['tz:Africa/Lagos', 'tz:Africa/Accra', 'tz:Europe/London', 'tz:America/New_York', 'tz:UTC', 'm:home']) assert.ok(cbs.includes(z), z);
  assert.ok(buttons(p).some((x) => x.text === '✓ UTC'), 'the default is marked');
  await b.msg(1, '/timezone');
  assert.match(b.tg.last().args[1], /Time zone/);
});

test('picking a zone saves it; /timezone accepts names, cities and offsets; bad input saves nothing', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.cb(1, 'tz:Africa/Lagos');
  assert.equal(tzOfUser(b, 1), 'Africa/Lagos');
  assert.match(b.tg.last().args[1], /Time zone set to <b>Lagos · Africa\/Lagos · UTC\+1<\/b>/);
  await b.cb(1, 'm:tz'); assert.ok(buttons(b.tg.last()).some((x) => x.text === '✓ Lagos'));
  await b.msg(1, '/timezone America/New_York'); assert.equal(tzOfUser(b, 1), 'America/New_York');
  await b.msg(1, '/timezone accra'); assert.equal(tzOfUser(b, 1), 'Africa/Accra');
  await b.msg(1, '/timezone UTC+5:30'); assert.equal(tzOfUser(b, 1), 'UTC+5:30');
  await b.msg(1, '/timezone Mars/Base');
  assert.match(b.tg.last().args[1], /do not know that time zone/); assert.equal(tzOfUser(b, 1), 'UTC+5:30');
  await b.cb(1, 'tz:Not/AZone'); assert.equal(tzOfUser(b, 1), 'UTC+5:30');
  await b.msg(1, '/timezone UTC'); assert.equal(tzOfUser(b, 1), null, 'UTC is stored as "no zone"');
});

test('one user\'s time zone never affects another user', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(2, '/start');
  await b.msg(1, '/timezone Africa/Lagos');
  assert.equal(tzOfUser(b, 2), null);
  await runWizard(b, 2, { when: '5:10 pm' });
  assert.match(b.tg.last().args[1], /At 2027-01-15 17:10 UTC/); assert.doesNotMatch(b.tg.last().args[1], /UTC\+1/);
});

test('with a zone set, "5:10 pm" is read in that zone and the confirmation shows both times', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/timezone Africa/Lagos');
  await runWizard(b, 1, { when: '5:10 pm' });                        // T0 is 2027-01-15 08:00 UTC = 09:00 in Lagos
  assert.match(b.tg.last().args[1], /At 2027-01-15 17:10 UTC\+1 \(16:10 UTC\)/);
  await b.cb(1, 'ok');
  assert.equal(b.db.prepare('SELECT scheduled_at FROM schedules').get().scheduled_at, at(16, 10));
});

test('adding "utc" to a time overrides the zone for that time only', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/timezone Africa/Lagos');
  await runWizard(b, 1, { when: '5:10 pm utc' });
  await b.cb(1, 'ok');
  assert.equal(b.db.prepare('SELECT scheduled_at FROM schedules').get().scheduled_at, at(17, 10));
});

test('the time step says which zone applies and its "Tomorrow 18:00" quick-pick follows it', async () => {
  const b = boot(); await b.msg(1, '/start');
  await toStep(b, 1, 'when');
  assert.match(b.tg.last().args[1], /Times are in UTC\./);
  assert.ok(buttons(b.tg.last()).some((x) => x.text === 'Set my time zone' || x.text === '🌍 Set my time zone'));
  await b.msg(1, '/timezone Africa/Lagos');                          // (a command ends the wizard, so start again)
  await toStep(b, 1, 'when');
  assert.match(b.tg.last().args[1], /Times are in your time zone \(<b>UTC\+1<\/b>\)/);
  assert.match(b.tg.last().args[1], /It is now <b>2027-01-15 09:00 UTC\+1 \(08:00 UTC\)<\/b>/);
  assert.ok(buttons(b.tg.last()).some((x) => x.text === 'Tomorrow 18:00 UTC+1'));
  assert.ok(buttons(b.tg.last()).some((x) => x.text === '🌍 Change time zone'));
  await b.cb(1, 't:tom'); await b.cb(1, 'ok');
  assert.equal(b.db.prepare('SELECT scheduled_at FROM schedules').get().scheduled_at, at(17, 0, 0) + 86400, '18:00 Lagos tomorrow is 17:00 UTC');
});

test('the zone button on the time step opens the picker and returns to the same step with the new zone', async () => {
  const b = boot(); await b.msg(1, '/start');
  await toStep(b, 1, 'when');
  await b.cb(1, 'tz:menu');
  assert.match(b.tg.last().args[1], /Time zone/); assert.ok(callbacks(b.tg.last()).includes('tz:back'));
  assert.equal(convo(b).state, 'sched.when', 'the wizard is still open behind the picker');
  await b.cb(1, 'tz:back');
  assert.match(b.tg.last().args[1], /Enter when MintPilot should sign/);
  await b.cb(1, 'tz:menu'); await b.cb(1, 'tz:Africa/Lagos');
  assert.equal(tzOfUser(b, 1), 'Africa/Lagos');
  assert.equal(convo(b).state, 'sched.when');
  assert.match(b.tg.last().args[1], /Enter when MintPilot should sign/); assert.match(b.tg.last().args[1], /UTC\+1/);
  await b.msg(1, '5:10 pm');
  assert.match(b.tg.last().args[1], /At 2027-01-15 17:10 UTC\+1 \(16:10 UTC\)/);
});

test('the zone picker also works from the "mint opens" step and keeps the wizard', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.msg(1, '/schedule'); await b.cb(1, 'c:base'); await b.msg(1, A(5)); await b.cb(1, 'p:1');
  await b.msg(1, '1'); await b.msg(1, '0.01'); await b.cb(1, 'mode:launch');
  assert.equal(convo(b).state, 'sched.launchAt');
  await b.cb(1, 'tz:menu'); await b.cb(1, 'tz:Europe/London');
  assert.equal(convo(b).state, 'sched.launchAt');
  assert.match(b.tg.last().args[1], /When does the mint open\?/);
});

test('/mints and the cancel card show times in the user\'s zone and in UTC', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(1, '/timezone Africa/Lagos');
  await runWizard(b, 1, { when: '+2h' }); await b.cb(1, 'ok');       // 10:00 UTC = 11:00 Lagos
  await b.msg(1, '/mints');
  assert.match(b.tg.last().args[1], /2027-01-15 11:00 UTC\+1 \(10:00 UTC\) \(in 2h\)/);
  await b.cb(1, 'x:1');
  assert.match(b.tg.last().args[1], /When: 2027-01-15 11:00 UTC\+1 \(10:00 UTC\)/);
});

test('a UTC user still sees plain UTC everywhere', async () => {
  const b = boot(); await b.msg(1, '/start');
  await runWizard(b, 1, { when: '+2h' }); await b.cb(1, 'ok');
  await b.msg(1, '/mints');
  assert.match(b.tg.last().args[1], /2027-01-15 10:00 UTC \(in 2h\)/); assert.doesNotMatch(b.tg.last().args[1], /UTC\+/);
});

// ───────── balance check includes the gas reserve the engine requires when it pre-signs ─────────
// Two tokens at 0.01 ETH = 0.02 ETH total. Gas cap for 2 tokens = 300000 + 100000 = 400000.
// Base fee 1 gwei x the armed multiplier (3x) = 3 gwei max fee, so the reserve is 400000 x 3 gwei = 0.0012 ETH.
const ETH = 10n ** 18n;
const bootWithFees = (balance, fee = 'ok', extra = {}) => {
  const state = { bal: balance };
  const b = boot({ rpc: {
    hasCode: async () => true,
    getBalance: async () => String(state.bal),
    getFeeInputs: async () => { if (fee === 'hang') return new Promise(() => {}); if (fee instanceof Error) throw fee; return { baseFeePerGas: 1_000_000_000n, priorityFeePerGas: 0n, gasPrice: null }; }
  }, ...extra });
  return { b, state };
};

test('confirm: the wallet must cover the mint total plus the gas reserve, and the card says so', async () => {
  const { b, state } = bootWithFees(ETH);
  await b.msg(1, '/start'); await runWizard(b, 1);
  let text = b.tg.last().args[1];
  assert.match(text, /Balance: <b>1 ETH<\/b> ✅ covers the mint total and the gas reserve \(up to 0\.0012 ETH gas reserve; only the gas actually used is charged\)/);
  state.bal = 21_000_000_000_000_000n;                              // 0.021 ETH: covers 0.02 but not 0.02 + 0.0012
  await b.cb(1, 'cf:refresh');
  text = b.tg.last().args[1];
  assert.match(text, /Not enough ETH on Base/);
  assert.match(text, /has <b>0\.021 ETH<\/b>, needs about <b>0\.0212 ETH<\/b> \(0\.02 mint \+ up to 0\.0012 ETH gas reserve/);
  assert.ok(callbacks(b.tg.last()).includes('cf:refresh'));
  state.bal = 21_200_000_000_000_000n;                              // exactly total + reserve is enough
  await b.cb(1, 'cf:refresh');
  assert.match(b.tg.last().args[1], /✅ covers the mint total and the gas reserve/);
  state.bal = 21_000_000_000_000_000n;                              // saving is allowed even when short
  await b.cb(1, 'cf:refresh'); await b.cb(1, 'ok');
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM schedules').get().n, 1);
});

test('confirm: the gas reserve scales with the number of tokens (the gas cap grows per token)', async () => {
  const { b } = bootWithFees(10_500_000_000_000_000n);              // 0.0105 ETH
  await b.msg(1, '/start'); await runWizard(b, 1, { qty: '1' });    // 1 token: total 0.01, cap 300000 -> reserve 0.0009
  assert.match(b.tg.last().args[1], /needs about <b>0\.0109 ETH<\/b> \(0\.01 mint \+ up to 0\.0009 ETH gas reserve/);
});

test('confirm: a free mint still needs the gas reserve', async () => {
  const { b, state } = bootWithFees(1_000_000_000_000_000n);        // 0.001 ETH
  await b.msg(1, '/start'); await runWizard(b, 1, { price: '0' });
  assert.match(b.tg.last().args[1], /needs about <b>0\.0012 ETH<\/b> \(free mint \+ up to 0\.0012 ETH gas reserve/);
  state.bal = 2_000_000_000_000_000n;
  await b.cb(1, 'cf:refresh');
  assert.match(b.tg.last().args[1], /✅ covers the mint total and the gas reserve/);
});

test('confirm: without fee data the check falls back to the mint total alone', async () => {
  for (const fee of [new Error('rpc down'), 'hang']) {
    const { b } = bootWithFees(21_000_000_000_000_000n, fee, { balanceCheckMs: 20 });
    await b.msg(1, '/start'); await runWizard(b, 1);
    const text = b.tg.last().args[1];
    assert.match(text, /Balance: <b>0\.021 ETH<\/b> ✅ covers the mint total\. Keep a little extra for the network fee\./);
    assert.doesNotMatch(text, /gas reserve/);
  }
});

test('admins get Premium with no expiry, and /revoke cannot remove it', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(999, '/start');
  assert.equal(planOf(getUser(b.db, 999), T0), 'premium');
  assert.equal(planOf(getUser(b.db, 999), T0 + 5 * 365 * 86400), 'premium');   // years later: still Premium
  assert.equal(planOf(getUser(b.db, 1), T0), 'free');                          // ordinary users are unaffected
  await b.msg(999, '/revoke 999');
  assert.equal(planOf(getUser(b.db, 999), T0), 'premium');
  assert.match(b.tg.last().args[1], /Admins always have Premium/);
});

test('support: a user message reaches the admins, and an admin can reply', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(999, '/start');
  await b.msg(1, '/support');
  assert.match(b.tg.last().args[1], /Contact support/);
  await b.msg(1, 'My mint number 1 did not run');
  assert.ok(b.tg.texts().some((x) => /Support message/.test(x) && /My mint number 1 did not run/.test(x) && /\/reply 1 /.test(x)));
  assert.match(b.tg.last().args[1], /We have your message/);
  await b.msg(999, '/reply 1 We are on it');
  assert.ok(b.tg.texts().some((x) => /MintPilot support/.test(x) && /We are on it/.test(x)));
  await b.msg(1, '/reply 1 hi'); // ordinary users cannot use the admin reply command
  assert.equal(b.tg.texts().filter((x) => /MintPilot support/.test(x)).length, 1);
});

test('announce: admins preview then send to every user; others are ignored', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(2, '/start'); await b.msg(999, '/start');
  await b.msg(1, '/announce hello everyone');
  assert.ok(!b.tg.texts().some((x) => /Preview/.test(x)));
  await b.msg(999, '/announce Maintenance at 10:00 UTC');
  assert.match(b.tg.last().args[1], /Send this to <b>3<\/b> users/);
  const mentions = () => b.tg.texts().filter((x) => /MintPilot update/.test(x) && /Maintenance at 10:00 UTC/.test(x)).length;
  assert.equal(mentions(), 1, 'only the preview exists before the admin confirms');
  await b.cb(999, 'ann:send');
  assert.equal(mentions(), 1 + 3, 'the preview plus one announcement per user');
});

test('health: admin-only status card', async () => {
  const b = boot(); await b.msg(1, '/start'); await b.msg(999, '/start');
  await b.msg(1, '/health');
  assert.ok(!b.tg.texts().some((x) => /MintPilot health/.test(x)));
  await b.msg(999, '/health');
  assert.match(b.tg.last().args[1], /MintPilot health/);
  assert.match(b.tg.last().args[1], /Users: 2/);
});

test('summary: a new user sees a friendly empty state, and the Help and Support buttons are connected', async () => {
  const b = boot(); await b.msg(1, '/start');
  await b.msg(1, '/summary');
  assert.match(b.tg.last().args[1], /Your MintPilot summary/);
  assert.match(b.tg.last().args[1], /Nothing scheduled yet/);
  await b.cb(1, 'm:help');
  assert.match(b.tg.last().args[1], /How MintPilot works/);
  await b.cb(1, 'm:support');
  assert.match(b.tg.last().args[1], /Contact support|Support is not set up/);
});

test('summary counts the user\'s own mints (Telegram ids are stored as text)', async () => {
  const b = boot(); await b.msg(1, '/start');
  const add = (status, at, qty) => b.db.prepare('INSERT INTO schedules (telegram_id, chain, contract, preset, quantity, price_wei, total_wei, wallet_address, scheduled_at, created_at, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('1', 'base', A(5), 'mint(uint256)', qty, '0', '0', A(1), at, T0, status);
  add('confirmed', T0 - 86400, 2); add('confirmed', T0 - 86400 * 30, 1); add('failed', T0 - 3600, 1); add('scheduled', T0 + 3600, 1); add('submitted', T0 - 60, 1);
  await b.msg(1, '/summary');
  const text = b.tg.last().args[1];
  assert.match(text, /1 mint confirmed/);
  assert.match(text, /2 mints · 3 NFTs/);
  assert.match(text, /1 mint did not go through/);
  assert.match(text, /1 mint scheduled/);
  assert.match(text, /1 mint sent, waiting for confirmation/);
});
