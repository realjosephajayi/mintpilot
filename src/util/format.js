'use strict';
const { localToUtc, localDate, zoneLabel } = require('./timezone');

/** Errors whose message is safe to show to end users. Anything else is logged, never echoed. */
class UserError extends Error {}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Decimal ETH string -> wei BigInt. Pure string math, max 18 decimals, no negatives. */
function parseEth(input) {
  const s = String(input).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new UserError('Enter a plain decimal amount in ETH, e.g. 0.01 (max 18 decimals).');
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0'));
}

function formatWei(wei) {
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const MAX_HORIZON_SEC = 180 * 24 * 3600;

// [YYYY-MM-DD ]hour[:minutes][ am|pm][ utc|gmt|z]. Without a date a clock time needs minutes or am/pm ("5" alone is ambiguous).
const CLOCK_RE = /^(?:(\d{4})-(\d{2})-(\d{2})[ T]\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(?:([ap])\.?m\.?)?\s*(utc|gmt|z)?$/i;

/**
 * Clock times and dates are read in `zone` (the user's time zone, UTC by default) unless the text ends in
 * "utc". Accepts:
 *   a clock time       "5:10 pm", "5pm", "17:10", "5.10pm UTC"  -> the next time the clock shows it, at :00 seconds
 *   a date and a time  "2026-11-01 18:00", "2026-11-01 6:30 pm"
 *   an offset          "+90m", "+2h", "+1d"                      -> rounded down to a whole minute
 *   unix seconds       10 digits
 * Returns unix seconds. Throws a user-readable Error.
 */
function parseWhen(input, now, zone = 'UTC') {
  const s = String(input).trim();
  let ts;
  let m;
  if (/^\d{10}$/.test(s)) ts = Number(s);
  else if ((m = s.match(/^\+(\d{1,4})\s*([mhd])$/i))) {
    const unit = { m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
    // "+10m" at 10:20:20 means 10:30:00, not 10:30:20. A very short offset that rounds into the next
    // 30 seconds moves on to the following minute instead of being refused.
    ts = Math.floor((now + Number(m[1]) * unit) / 60) * 60;
    if (ts < now + 30) ts += 60;
  } else if ((m = s.match(CLOCK_RE)) && (m[1] || m[5] !== undefined || m[6])) {
    const [, y, mo, d, hh, mm, ap, explicitUtc] = m;
    const tz = explicitUtc ? 'UTC' : zone;
    let h = Number(hh);
    const mi = mm === undefined ? 0 : Number(mm);
    if (ap) {
      if (h < 1 || h > 12) throw new UserError('With am or pm the hour must be from 1 to 12, for example "5:10 pm".');
      h = (h % 12) + (ap.toLowerCase() === 'p' ? 12 : 0);
    }
    if (h > 23 || mi > 59) throw new UserError(y ? 'That date does not exist.' : 'That time does not exist. Use a time like "5:10 pm" or "17:10".');
    if (y) {
      const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), h, mi));
      if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) throw new UserError('That date does not exist.');
      ts = localToUtc(Number(y), Number(mo), Number(d), h, mi, tz);
    } else {
      // No date: the next time the clock shows this, today if it has not passed yet and otherwise tomorrow.
      const today = localDate(tz, now);
      ts = localToUtc(today.y, today.mo, today.d, h, mi, tz);
      if (ts <= now) { const next = new Date(Date.UTC(today.y, today.mo - 1, today.d + 1)); ts = localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), h, mi, tz); }
    }
  } else {
    throw new UserError(`Use a time like "5:10 pm" or "17:10" (${zoneLabel(zone, now)}), a date and time like "${new Date((now + 86400) * 1000).toISOString().slice(0, 10)} 18:00", "+2h", "+30m", "+1d" or a 10-digit Unix timestamp.`);
  }
  if (ts < now + 30) throw new UserError('Pick a time at least 30 seconds in the future.');
  if (ts > now + MAX_HORIZON_SEC) throw new UserError('Pick a time within the next 180 days.');
  return ts;
}

const utc = (ts) => new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/**
 * Heuristic detector for secrets pasted into chat. Not exhaustive — it exists to
 * catch the common accidents (raw private key, 12/24-word mnemonic).
 */
function looksLikeSecret(text) {
  const t = String(text).trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return 'private_key';
  const words = t.split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w))) return 'seed_phrase';
  return null;
}

module.exports = { UserError, esc, shortAddr, parseEth, formatWei, parseWhen, utc, looksLikeSecret, MAX_HORIZON_SEC };
