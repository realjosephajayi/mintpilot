'use strict';
// Premium is sold with Telegram Stars (currency "XTR"), the payment method Telegram requires for
// digital goods in bots. Telegram verifies the payment; we only grant premium from the signed
// `successful_payment` service message, and idempotently by charge id.
const { tx } = require('../db');
const { extendPremium, getUser } = require('./users');

const payloadFor = (telegramId, days) => `premium_v1:${telegramId}:${days}`;

function invoiceFor(cfg, telegramId) {
  return {
    title: `MintPilot Premium — ${cfg.premium.days} days`,
    description: `Up to ${cfg.plans.premium.activeSchedules} active schedules, ${cfg.plans.premium.wallets} wallets, pre-mint alerts 10 min and 1 min before start.`,
    payload: payloadFor(telegramId, cfg.premium.days),
    currency: 'XTR',
    prices: [{ label: `Premium ${cfg.premium.days}d`, amount: cfg.premium.priceStars }]
  };
}

/** Validate a pre_checkout_query. Returns { ok:true } or { ok:false, error }. */
function validatePreCheckout(db, cfg, q) {
  const expected = payloadFor(q.from.id, cfg.premium.days);
  if (q.invoice_payload !== expected) return { ok: false, error: 'This invoice is not valid for your account. Please request a new one with /premium.' };
  if (q.currency !== 'XTR' || q.total_amount !== cfg.premium.priceStars) return { ok: false, error: 'The price has changed. Please request a new invoice with /premium.' };
  const u = getUser(db, q.from.id);
  if (!u || u.banned) return { ok: false, error: 'Account not eligible.' };
  return { ok: true };
}

/** Record a successful payment and grant premium. Safe to call repeatedly for the same charge. */
function recordPayment(db, cfg, fromId, sp, now) {
  return tx(db, () => {
    if (sp.invoice_payload !== payloadFor(fromId, cfg.premium.days) || sp.currency !== 'XTR' || sp.total_amount !== cfg.premium.priceStars) {
      return { granted: false, reason: 'mismatch' };
    }
    const r = db.prepare('INSERT OR IGNORE INTO payments (telegram_id, charge_id, amount, currency, days, created_at) VALUES (?,?,?,?,?,?)')
      .run(String(fromId), sp.telegram_payment_charge_id, sp.total_amount, sp.currency, cfg.premium.days, now);
    if (!r.changes) return { granted: false, reason: 'duplicate' };
    const premiumUntil = extendPremium(db, fromId, cfg.premium.days, now);
    return { granted: true, premiumUntil };
  });
}

module.exports = { invoiceFor, validatePreCheckout, recordPayment, payloadFor };
