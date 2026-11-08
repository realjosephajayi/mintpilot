'use strict';
// Time zones for typing and showing times. A zone is an IANA name ("Africa/Lagos", which follows daylight
// saving where the country uses it) or a fixed offset ("UTC+1", "UTC-5:30"). "UTC" is the default.

const OFFSET_RE = /^(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i;
const FIXED_RE = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/;

/** Zones offered as buttons: [IANA name, short label]. */
const POPULAR_ZONES = [
  ['Africa/Lagos', 'Lagos'], ['Africa/Accra', 'Accra'], ['Africa/Nairobi', 'Nairobi'], ['Africa/Johannesburg', 'Johannesburg'],
  ['Africa/Cairo', 'Cairo'], ['Europe/London', 'London'], ['Europe/Paris', 'Paris'], ['Europe/Istanbul', 'Istanbul'],
  ['Asia/Dubai', 'Dubai'], ['Asia/Kolkata', 'India'], ['Asia/Singapore', 'Singapore'], ['Asia/Tokyo', 'Tokyo'],
  ['Australia/Sydney', 'Sydney'], ['America/New_York', 'New York'], ['America/Chicago', 'Chicago'], ['America/Los_Angeles', 'Los Angeles'],
  ['America/Sao_Paulo', 'São Paulo'], ['UTC', 'UTC']
];

const formatters = new Map();
const dtf = (zone) => {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(zone, f);
  }
  return f;
};

/**
 * Turn what the user typed into a stored zone, or null if it is not one. Accepts "Africa/Lagos" (any case),
 * a popular city name ("lagos"), "UTC", and fixed offsets ("UTC+1", "GMT-5:30").
 */
function parseZone(input) {
  const s = String(input ?? '').trim();
  if (!s || s.length > 64) return null;
  if (/^(utc|gmt|z)$/i.test(s)) return 'UTC';
  const o = s.match(OFFSET_RE);
  if (o) {
    const h = Number(o[2]); const mi = o[3] === undefined ? 0 : Number(o[3]);
    if (h > 14 || mi > 59 || (h === 14 && mi > 0)) return null;
    if (h === 0 && mi === 0) return 'UTC';
    return `UTC${o[1]}${h}${mi ? `:${String(mi).padStart(2, '0')}` : ''}`;
  }
  const city = POPULAR_ZONES.find(([, label]) => label.toLowerCase() === s.toLowerCase());
  if (city) return city[0];
  if (/^[+-]?\d/.test(s) || !/[A-Za-z]/.test(s)) return null; // numeric offsets like "+01:00" are not names
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: s.replace(/\s+/g, '_') }).resolvedOptions().timeZone;
    return /^[+-]/.test(name) ? null : name;
  } catch { return null; }
}

/** Seconds to add to a UTC timestamp to get the zone's wall-clock time at that moment. */
function offsetSec(zone, ts) {
  if (!zone || zone === 'UTC') return 0;
  const f = zone.match(FIXED_RE);
  if (f) return (f[1] === '-' ? -1 : 1) * (Number(f[2]) * 3600 + Number(f[3] || 0) * 60);
  const p = {};
  for (const part of dtf(zone).formatToParts(new Date(ts * 1000))) p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - ts;
}

/** The unix time at which the zone's clock shows this local date and time. */
function localToUtc(y, mo, d, h, mi, zone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi) / 1000;
  const ts = guess - offsetSec(zone, guess);
  return guess - offsetSec(zone, ts); // a second pass settles times near a daylight-saving change
}

/** The local calendar date in the zone at this moment. */
function localDate(zone, ts) {
  const t = new Date((ts + offsetSec(zone, ts)) * 1000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** "UTC", "UTC+1", "UTC-5", "UTC+5:30": the zone's offset at that moment. */
function zoneLabel(zone, ts) {
  const off = offsetSec(zone, ts);
  if (!off) return 'UTC';
  const abs = Math.abs(off); const h = Math.floor(abs / 3600); const mi = Math.floor((abs % 3600) / 60);
  return `UTC${off < 0 ? '-' : '+'}${h}${mi ? `:${String(mi).padStart(2, '0')}` : ''}`;
}

/** "2027-01-15 18:10 UTC+1 (17:10 UTC)" in a zone, "2027-01-15 17:10 UTC" in UTC. */
function formatWhen(ts, zone) {
  const u = new Date(ts * 1000).toISOString();
  const off = offsetSec(zone, ts);
  if (!off) return `${u.slice(0, 10)} ${u.slice(11, 16)} UTC`;
  const l = new Date((ts + off) * 1000).toISOString();
  const utcPart = l.slice(0, 10) === u.slice(0, 10) ? `${u.slice(11, 16)} UTC` : `${u.slice(0, 10)} ${u.slice(11, 16)} UTC`;
  return `${l.slice(0, 10)} ${l.slice(11, 16)} ${zoneLabel(zone, ts)} (${utcPart})`;
}

/** A readable name for the settings screen: "Lagos · Africa/Lagos · UTC+1". */
function describeZone(zone, ts) {
  const z = zone || 'UTC';
  const city = POPULAR_ZONES.find(([name]) => name === z);
  const label = zoneLabel(z, ts);
  return [city && city[1] !== z ? city[1] : null, z === 'UTC' || z === label ? null : z, label].filter(Boolean).join(' · ');
}

module.exports = { POPULAR_ZONES, parseZone, offsetSec, localToUtc, localDate, zoneLabel, formatWhen, describeZone };
