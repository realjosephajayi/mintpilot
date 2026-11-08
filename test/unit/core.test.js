'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { T0, A, makeCfg, makeDb, addUser, addWallet, getChains } = require('./helpers');
const { upsertUser, getUser, planOf, extendPremium } = require('../../src/core/users');
const { registerReferral, rewardReferral, referralStats } = require('../../src/core/referrals');
const { createLinkSession, getValidSession, consumeSession } = require('../../src/core/sessions');
const { removeWallet, normalizeAddress, WalletError } = require('../../src/core/wallets');
const { createSchedule, createSchedules, cancelSchedule, claimReminder, completeReminder, ScheduleError, getSchedule, expireStale, deferSchedule, failSchedule, scheduleDeadline } = require('../../src/core/schedules');
const { addTrackedTx, TrackError } = require('../../src/core/tracking');
const { validatePreCheckout, recordPayment, payloadFor } = require('../../src/core/payments');

const cfg = makeCfg();
const chains = getChains(cfg);
const sched = (id, over = {}) => ({ telegramId: id, chain: 'base', contract: A(5), preset: 'mint(uint256)', quantity: 2, priceWei: '0.01', scheduledAt: T0 + 3600, wallet: A(1), ...over });

test('premium extends from max(now, current expiry) and plan is derived from expiry', () => {
  const db = makeDb(); addUser(db, 1);
  assert.equal(planOf(getUser(db, 1), T0), 'free');
  const u1 = extendPremium(db, 1, 30, T0);
  assert.equal(u1, T0 + 30 * 86400);
  assert.equal(extendPremium(db, 1, 10, T0 + 86400), u1 + 10 * 86400); // stacks on top
  assert.equal(planOf(getUser(db, 1), T0 + 31 * 86400), 'premium');
  assert.equal(planOf(getUser(db, 1), u1 + 11 * 86400), 'free');
});

test('referrals: new users only, no self-referral, one referrer, rewarded once and capped', () => {
  const db = makeDb();
  const { user: ref } = upsertUser(db, { id: 1 }, T0);
  assert.equal(registerReferral(db, 1, ref.ref_code, T0), false);          // self
  assert.equal(registerReferral(db, 2, 'nope', T0), false);                // unknown code
  upsertUser(db, { id: 2 }, T0);
  assert.equal(registerReferral(db, 2, ref.ref_code, T0), true);
  upsertUser(db, { id: 3 }, T0); registerReferral(db, 3, ref.ref_code, T0);
  assert.equal(registerReferral(db, 2, getUser(db, 3).ref_code, T0), false); // already has a referrer
  assert.deepEqual(referralStats(db, 1), { rewarded: 0, pending: 2 });

  assert.deepEqual(rewardReferral(db, cfg, 2, T0), { referrerId: '1' });
  assert.equal(rewardReferral(db, cfg, 2, T0), null);                        // not twice
  assert.equal(getUser(db, 1).premium_until, T0 + cfg.referral.referrerDays * 86400);
  assert.equal(getUser(db, 2).premium_until, T0 + cfg.referral.refereeDays * 86400);

  const capped = { ...cfg, referral: { ...cfg.referral, maxRewards: 1 } };
  assert.equal(rewardReferral(db, capped, 3, T0), null);                     // cap reached
});

test('sessions are single-use, expire, and are kind-scoped', () => {
  const db = makeDb(); addUser(db, 1);
  const id = createLinkSession(db, { telegramId: 1, domain: 'bot.example', ttlSec: 60 }, T0);
  assert.ok(getValidSession(db, id, 'link', T0 + 10).challenge.includes('Telegram account: 1'));
  assert.equal(getValidSession(db, id, 'mint', T0 + 10), null);
  assert.equal(getValidSession(db, id, 'link', T0 + 61), null);
  assert.equal(consumeSession(db, id, T0 + 10), true);
  assert.equal(consumeSession(db, id, T0 + 11), false);
  assert.equal(getValidSession(db, id, 'link', T0 + 12), null);
  assert.equal(getValidSession(db, 'short', 'link', T0), null);
});

test('wallets: checksum enforced, unique across accounts, plan limit, unlink cancels schedules', () => {
  assert.throws(() => normalizeAddress('0x123'), /valid/);
  assert.throws(() => normalizeAddress('0x' + '0'.repeat(40)), /zero/);
  assert.equal(normalizeAddress(A(7).toUpperCase().replace('0X', '0x')), A(7)); // all-caps hex = no checksum claim

  const db = makeDb(); addUser(db, 1); addUser(db, 2); addUser(db, 3, { premium: true });
  assert.equal(addWallet(db, cfg, 1, A(1)).isFirst, true);
  assert.throws(() => addWallet(db, cfg, 2, A(1)), (e) => e instanceof WalletError && e.code === 'WALLET_TAKEN');
  assert.throws(() => addWallet(db, cfg, 1, A(2)), (e) => e.code === 'WALLET_LIMIT');     // free = 1
  for (let i = 10; i < 15; i++) addWallet(db, cfg, 3, A(i));                                // premium = 5
  assert.throws(() => addWallet(db, cfg, 3, A(15)), (e) => e.code === 'WALLET_LIMIT');
  assert.equal(addWallet(db, cfg, 1, A(1)).alreadyLinked, true);

  const id = createSchedule(db, cfg, chains, sched(1), T0);
  const wid = db.prepare('SELECT id FROM wallets WHERE address=?').get(A(1)).id;
  assert.equal(removeWallet(db, 2, wid), false);                                            // not yours
  assert.equal(removeWallet(db, 1, wid), true);
  assert.equal(getSchedule(db, id).status, 'cancelled');
});

test('schedules: validation, safety cap, ownership, plan limits, cancel authorization', () => {
  const db = makeDb(); addUser(db, 1); addUser(db, 2); addWallet(db, cfg, 1, A(1));
  const id = createSchedule(db, cfg, chains, sched(1), T0);
  const row = getSchedule(db, id);
  assert.equal(row.total_wei, (2n * 10n ** 16n).toString());
  assert.equal(row.status, 'scheduled');

  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { chain: 'solana' }), T0), ScheduleError);
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { chain: 'sepolia' }), T0), /Unsupported network/); // testnets off
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { preset: 'transfer(address,uint256)' }), T0), /method/);
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { quantity: 11 }), T0), /Quantity/);
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { priceWei: '0.6' }), T0), /safety cap/);  // 0.6*2 > 1 ETH
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { scheduledAt: T0 + 5 }), T0), /future/);
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { wallet: A(9) }), T0), /not one of your MintPilot wallets/);
  assert.throws(() => createSchedule(db, cfg, chains, sched(2), T0), /not one of your MintPilot wallets/);   // can't use another user's wallet

  createSchedule(db, cfg, chains, sched(1), T0); createSchedule(db, cfg, chains, sched(1), T0);
  assert.throws(() => createSchedule(db, cfg, chains, sched(1), T0), /free plan allows 3/);
  assert.equal(cancelSchedule(db, id, 2), false);   // other user
  assert.equal(cancelSchedule(db, id, 1), true);
  assert.equal(cancelSchedule(db, id, 1), false);   // already cancelled
  createSchedule(db, cfg, chains, sched(1), T0);    // slot freed
});

test('schedules persist validated adapter specifications', () => {
  const db = makeDb(); addUser(db, 1); addWallet(db, cfg, 1, A(1));
  const mintSpec = {
    adapter: 'direct', signature: 'safeMint(address,uint256)', quantity: 2, priceWei: '7'
  };
  const id = createSchedule(db, cfg, chains, sched(1, { mintSpec, priceWei: '0' }), T0);
  const row = getSchedule(db, id);
  assert.equal(row.preset, 'adapter:direct');
  assert.equal(row.total_wei, '14');
  assert.deepEqual(JSON.parse(row.mint_spec), mintSpec);
});

test('OpenSea schedule persists slug and spend ceiling without storing an API transaction', () => {
  const db = makeDb(); addUser(db, 1); addWallet(db, cfg, 1, A(1));
  const mintSpec = { adapter: 'opensea-drop', slug: 'example-drop', quantity: 2, priceWei: '500', feeBps: 1000 };
  const id = createSchedule(db, cfg, chains, sched(1, { mintSpec, quantity: 2, priceWei: 500n }), T0);
  const row = getSchedule(db, id);
  assert.equal(row.preset, 'adapter:opensea-drop');
  assert.equal(row.price_wei, '500');
  assert.equal(row.total_wei, '1000');
  assert.deepEqual(JSON.parse(row.mint_spec), mintSpec);
  assert.equal('transaction' in JSON.parse(row.mint_spec), false);
});

test('launch schedules persist trigger and on-chain phase window metadata', () => {
  const db = makeDb(); addUser(db, 1); addWallet(db, cfg, 1, A(1));
  const id = createSchedule(db, cfg, chains, sched(1, { scheduledAt: T0 + 1, triggerMode: 'launch', launchAt: T0 + 100, endAt: T0 + 200 }), T0);
  const row = getSchedule(db, id);
  assert.equal(row.trigger_mode, 'launch');
  assert.equal(row.launch_at, T0 + 100);
  assert.equal(row.end_at, T0 + 200);
});

test('launch schedules accept a stale wizard timestamp and wake immediately', () => {
  const db = makeDb(); addUser(db, 1); addWallet(db, cfg, 1, A(1));
  const id = createSchedule(db, cfg, chains, sched(1, { scheduledAt: T0 + 1, triggerMode: 'launch', launchAt: T0 + 5 }), T0 + 10);
  assert.equal(getSchedule(db, id).scheduled_at, T0 + 10);
  assert.equal(getSchedule(db, id).launch_at, T0 + 5, 'an opening time in the past is allowed (already open)');
});

test('multi-wallet schedule creation is atomic', () => {
  const db = makeDb(); addUser(db, 1, { premium: true }); addWallet(db, cfg, 1, A(1)); addWallet(db, cfg, 1, A(2));
  assert.throws(() => createSchedules(db, cfg, chains, [sched(1, { wallet: A(1) }), sched(1, { wallet: A(9) })], T0), /not one of your MintPilot wallets/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE telegram_id='1'").get().n, 0);
});

test('premium users get higher schedule limits', () => {
  const db = makeDb(); addUser(db, 1, { premium: true }); addWallet(db, cfg, 1, A(1));
  for (let i = 0; i < 10; i++) createSchedule(db, cfg, chains, sched(1), T0);
});

test('reminders remain retryable until completed, then are idempotent', () => {
  const db = makeDb(); addUser(db, 1); addWallet(db, cfg, 1, A(1));
  const id = createSchedule(db, cfg, chains, sched(1), T0);
  assert.equal(claimReminder(db, id, 'due', T0), true);
  assert.equal(claimReminder(db, id, 'due', T0), true);
  assert.equal(completeReminder(db, id, 'due', T0), true);
  assert.equal(claimReminder(db, id, 'due', T0), false);
  assert.equal(completeReminder(db, id, 'due', T0), false);
});

test('tracking: hash validation, dedupe, pending limit by plan, system bypass', () => {
  const db = makeDb(); addUser(db, 1);
  const h = (n) => '0x' + String(n).padStart(64, '0');
  assert.throws(() => addTrackedTx(db, cfg, { telegramId: 1, chain: 'base', txHash: '0x12' }, T0), TrackError);
  assert.equal(addTrackedTx(db, cfg, { telegramId: 1, chain: 'base', txHash: h(1) }, T0).duplicate, false);
  assert.equal(addTrackedTx(db, cfg, { telegramId: 1, chain: 'base', txHash: h(1) }, T0).duplicate, true);
  for (let i = 2; i <= 5; i++) addTrackedTx(db, cfg, { telegramId: 1, chain: 'base', txHash: h(i) }, T0);
  assert.throws(() => addTrackedTx(db, cfg, { telegramId: 1, chain: 'base', txHash: h(6) }, T0), /free plan can track 5/);
  addTrackedTx(db, cfg, { telegramId: 1, chain: 'base', txHash: h(6), system: true }, T0);
});

test('payments: pre-checkout validation and idempotent premium grant', () => {
  const db = makeDb(); addUser(db, 1);
  const good = { from: { id: 1 }, invoice_payload: payloadFor(1, cfg.premium.days), currency: 'XTR', total_amount: cfg.premium.priceStars };
  assert.equal(validatePreCheckout(db, cfg, good).ok, true);
  assert.equal(validatePreCheckout(db, cfg, { ...good, total_amount: 1 }).ok, false);
  assert.equal(validatePreCheckout(db, cfg, { ...good, currency: 'USD' }).ok, false);
  assert.equal(validatePreCheckout(db, cfg, { ...good, from: { id: 2 } }).ok, false); // payload bound to payer

  const sp = { invoice_payload: good.invoice_payload, currency: 'XTR', total_amount: cfg.premium.priceStars, telegram_payment_charge_id: 'chg_1' };
  const r1 = recordPayment(db, cfg, 1, sp, T0);
  assert.equal(r1.granted, true);
  assert.equal(r1.premiumUntil, T0 + cfg.premium.days * 86400);
  assert.equal(recordPayment(db, cfg, 1, sp, T0).reason, 'duplicate');              // replayed webhook
  assert.equal(getUser(db, 1).premium_until, T0 + cfg.premium.days * 86400);        // granted once
  assert.equal(recordPayment(db, cfg, 1, { ...sp, telegram_payment_charge_id: 'chg_2', total_amount: 5 }, T0).reason, 'mismatch');
});

test('db.tx is re-entrant: inner failure rolls back only the inner work', () => {
  const { tx } = require('../../src/db');
  const db = makeDb(); addUser(db, 1);
  tx(db, () => {
    db.prepare("INSERT INTO kv VALUES ('a','1')").run();
    assert.throws(() => tx(db, () => { db.prepare("INSERT INTO kv VALUES ('b','2')").run(); throw new Error('boom'); }), /boom/);
  });
  assert.ok(db.prepare("SELECT 1 FROM kv WHERE key='a'").get());
  assert.equal(db.prepare("SELECT 1 FROM kv WHERE key='b'").get(), undefined);
  assert.throws(() => tx(db, () => { db.prepare("INSERT INTO kv VALUES ('c','3')").run(); throw new Error('x'); }));
  assert.equal(db.prepare("SELECT 1 FROM kv WHERE key='c'").get(), undefined);
});

test('schedules are refused up front when they cannot be auto-signed', () => {
  const db = makeDb(); addUser(db, 1, { premium: true }); addWallet(db, cfg, 1, A(1));
  addWallet(db, cfg, 1, A(2), T0, { signable: false });
  const off = { ...cfg, automation: { ...cfg.automation, enabled: false } };
  assert.throws(() => createSchedule(db, off, chains, sched(1), T0), /Automatic signing is not configured/);
  const noKey = { ...cfg, automation: { ...cfg.automation, encryptionKey: '' } };
  assert.throws(() => createSchedule(db, noKey, chains, sched(1), T0), /Automatic signing is not configured/);
  const onlyEth = { ...cfg, automation: { ...cfg.automation, allowedChains: ['ethereum'] } };
  assert.throws(() => createSchedule(db, onlyEth, chains, sched(1), T0), /not enabled for Base/);
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { chain: 'base-sepolia' }), T0), /Unsupported network/); // no testnets exist
  const lowCap = { ...cfg, automation: { ...cfg.automation, maxValueEth: '0.01' } };
  assert.throws(() => createSchedule(db, lowCap, chains, sched(1), T0), /automatic-signing cap/);
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { wallet: A(2) }), T0), /no signing key/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schedules').get().n, 0);
});

test('launch schedules need an opening time and a window that has not ended', () => {
  const db = makeDb(); addUser(db, 1); addWallet(db, cfg, 1, A(1));
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { triggerMode: 'launch', launchAt: null }), T0), /opening time/);
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { triggerMode: 'launch', launchAt: T0 + 100, endAt: T0 - 1 }), T0), /already ended/);
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { triggerMode: 'launch', launchAt: T0 + 100, endAt: T0 + 50 }), T0), /must end after it opens/);
});

test('persisted specs are checked against the adapter key allowlist (no file/URL sources)', () => {
  const db = makeDb(); addUser(db, 1); addWallet(db, cfg, 1, A(1));
  const spec = { adapter: 'merkle', signatureFunction: 'mint(uint256,bytes32[])', quantity: 1, priceWei: '0', proof: [] };
  assert.doesNotThrow(() => createSchedule(db, cfg, chains, sched(1, { mintSpec: spec, quantity: 1, priceWei: 0n }), T0));
  assert.throws(() => createSchedule(db, cfg, chains, sched(1, { mintSpec: { ...spec, proofFile: '/etc/passwd' }, quantity: 1, priceWei: 0n }), T0), /Unsupported field.*proofFile/);
});

test('deadlines, deferral and failure helpers', () => {
  const db = makeDb(); addUser(db, 1, { premium: true }); addWallet(db, cfg, 1, A(1));
  const manual = createSchedule(db, cfg, chains, sched(1), T0);
  const launch = createSchedule(db, cfg, chains, sched(1, { triggerMode: 'launch', launchAt: T0 + 100, endAt: T0 + 500 }), T0);
  assert.equal(scheduleDeadline(getSchedule(db, manual), 1000), T0 + 3600 + 1000);
  assert.equal(scheduleDeadline(getSchedule(db, launch), 1000), T0 + 500);
  assert.equal(deferSchedule(db, manual, { nextAttemptAt: T0 + 3700, lastError: 'not open' }), true);
  assert.equal(getSchedule(db, manual).attempts, 1);
  assert.deepEqual(expireStale(db, T0 + 501, 1000).map((r) => r.id), [launch]);
  assert.deepEqual(expireStale(db, T0 + 501, 1000), [], 'expired once');
  assert.equal(failSchedule(db, manual, 'sold out'), true);
  assert.equal(getSchedule(db, manual).status, 'failed');
  assert.equal(failSchedule(db, manual, 'again'), false);
});
