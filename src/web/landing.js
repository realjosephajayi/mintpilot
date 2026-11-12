'use strict';
// Fills the public front page (src/web/public/index.html) with live settings, so the plans, network list
// and Telegram link always match what the bot is actually configured to do.

const escHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const li = (text) => `<li>${escHtml(text)}</li>`;
const count = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;

function renderLanding(template, { cfg, chains = {}, botUsername = '', year = new Date().getUTCFullYear() } = {}) {
  const name = String(botUsername || '').replace(/^@/, '');
  const botUrl = /^[A-Za-z0-9_]{4,32}$/.test(name) ? `https://t.me/${name}` : '#how';
  const allowed = (cfg?.automation?.allowedChains?.length ? cfg.automation.allowedChains : Object.keys(chains)).filter((key) => chains[key]);
  const networks = allowed.map((key) => chains[key].name);
  const free = cfg?.plans?.free || {};
  const premium = cfg?.plans?.premium || {};
  const stars = cfg?.premium?.priceStars ?? 250;
  const days = cfg?.premium?.days ?? 30;

  const freeFeatures = [
    `${count(free.activeSchedules ?? 3, 'active scheduled mint', 'active scheduled mints')} at a time`,
    count(free.wallets ?? 1, 'wallet', 'wallets'),
    'Result alerts in Telegram',
    'Live, view-only dashboard'
  ];
  const premiumFeatures = [
    'Everything in Free',
    `${count(premium.activeSchedules ?? 30, 'active scheduled mint', 'active scheduled mints')} at a time`,
    count(premium.wallets ?? 5, 'wallet', 'wallets'),
    'Heads-up alerts before each mint',
    `Track up to ${premium.pendingTxs ?? 50} pending transactions`
  ];

  const tokens = {
    BOT_URL: botUrl,
    PUBLIC_URL: String(cfg?.publicUrl || '').replace(/\/+$/, ''),
    NETWORK_COUNT: String(networks.length || 10),
    NETWORK_CHIPS: networks.map(li).join(''),
    FREE_FEATURES: freeFeatures.map(li).join(''),
    PREMIUM_FEATURES: premiumFeatures.map(li).join(''),
    PREMIUM_STARS: String(stars),
    PREMIUM_DAYS: String(days),
    YEAR: String(year)
  };
  return Object.entries(tokens).reduce((html, [key, value]) => html.split(`__${key}__`).join(value), template);
}

module.exports = { renderLanding };
