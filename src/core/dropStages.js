'use strict';
// Turns OpenSea's drop "stages" into a short, plain timeline so people see what they are scheduling against:
// which stage is live, which are coming, who can mint in each, and how much supply is left.

const NATIVE = '0x0000000000000000000000000000000000000000';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toSec = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
const plainEsc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const plainWei = (wei) => { const n = BigInt(wei); const whole = n / 10n ** 18n; const frac = (n % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, ''); return `${whole}${frac ? `.${frac}` : ''}`; };

/** The stages OpenSea lists for a drop, oldest first, with times in epoch seconds. */
function normalizeStages(drop) {
  const raw = Array.isArray(drop?.stages) ? drop.stages : [];
  return raw.map((s) => {
    const currency = String(s.price_currency_address || NATIVE).toLowerCase();
    return {
      label: String(s.label || s.stage_type || 'Stage').slice(0, 60),
      type: s.stage_type === 'public_sale' ? 'public' : 'allowlist',
      start: toSec(s.start_time),
      end: toSec(s.end_time),
      priceWei: currency === NATIVE && /^\d+$/.test(String(s.price ?? '')) ? String(s.price) : null,
      paidInToken: currency !== NATIVE,
      maxPerWallet: /^\d+$/.test(String(s.max_per_wallet ?? '')) ? Number(s.max_per_wallet) : null,
      wallets: Number.isInteger(s.allowlist_wallet_count) ? s.allowlist_wallet_count : null
    };
  }).filter((s) => s.start && s.end).sort((a, b) => a.start - b.start);
}

const stageState = (s, nowSec) => (nowSec >= s.end ? 'ended' : nowSec >= s.start ? 'live' : 'upcoming');

function clock(sec, nowSec) {
  const d = new Date(sec * 1000);
  const hm = d.toISOString().slice(11, 16);
  return d.toISOString().slice(0, 10) === new Date(nowSec * 1000).toISOString().slice(0, 10) ? hm : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hm}`;
}

/** HTML for a chat message: the live and upcoming stages (plus the most recent finished one). */
function describeStages(stages, nowSec, { esc = plainEsc, formatWei = plainWei } = {}) {
  if (!stages.length) return '';
  const ended = stages.filter((s) => stageState(s, nowSec) === 'ended');
  const shown = [...ended.slice(-1), ...stages.filter((s) => stageState(s, nowSec) !== 'ended')];
  const lines = shown.slice(0, 6).map((s) => {
    const icon = { ended: '⏹', live: '🟢', upcoming: '⏳' }[stageState(s, nowSec)];
    const who = s.type === 'public' ? 'public sale' : `allowlist${s.wallets != null ? ` (${s.wallets.toLocaleString('en-US')} wallets)` : ''}`;
    const price = s.paidInToken ? 'paid in a token' : s.priceWei == null ? '' : (BigInt(s.priceWei) === 0n ? 'free' : `${formatWei(s.priceWei)} ETH`);
    const parts = [`${clock(s.start, nowSec)}–${clock(s.end, nowSec)} UTC`, who, s.maxPerWallet != null ? `${s.maxPerWallet} per wallet` : '', price].filter(Boolean);
    return `${icon} <b>${esc(s.label)}</b>: ${parts.join(', ')}`;
  });
  const more = shown.length > 6 ? `\n…and ${shown.length - 6} more` : '';
  const note = shown.some((s) => s.type === 'allowlist' && stageState(s, nowSec) !== 'ended')
    ? '\nAllowlist stages only accept wallets on their list, and MintPilot cannot check that before a stage opens.' : '';
  return `<b>Stages</b> (times in UTC)\n${lines.join('\n')}${more}${note}`;
}

/** One line on supply, with a warning when little is left. `supply` is { minted, max } as decimal strings, or null. */
function supplyLine(supply) {
  if (!supply) return '';
  const minted = BigInt(supply.minted); const max = BigInt(supply.max);
  if (max <= 0n) return '';
  const left = max > minted ? max - minted : 0n;
  const warn = left <= 100n || left * 20n <= max;
  return `Minted: ${minted.toLocaleString('en-US')} of ${max.toLocaleString('en-US')} (${left.toLocaleString('en-US')} left)${warn ? '\n⚠️ Not much is left. Earlier stages can use it all up before a later stage opens.' : ''}`;
}

module.exports = { normalizeStages, stageState, describeStages, supplyLine };
