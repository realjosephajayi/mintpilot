'use strict';
// Measures every configured RPC endpoint the way the bot uses it: round-trip time and how old the newest block is.
// Run it where the bot runs, so the numbers include the real distance to the provider:
//   Railway Console:  node scripts/rpc-latency.js
//   Your computer:    node --env-file=.env scripts/rpc-latency.js
const { loadConfig } = require('../src/config');
const { getChains } = require('../src/chains');

const ROUNDS = 7;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const host = (url) => { try { return new URL(url).host; } catch { return 'rpc'; } };

async function latest(url) {
  const started = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }),
    signal: AbortSignal.timeout(8000)
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error?.message || `HTTP ${res.status}`);
  return { ms: performance.now() - started, ageSec: Math.max(0, Math.floor(Date.now() / 1000) - parseInt(body.result.timestamp, 16)) };
}

(async () => {
  const cfg = loadConfig();
  const chains = getChains(cfg);
  const allowed = cfg.automation.allowedChains || [];
  const keys = (allowed.length ? allowed : Object.keys(chains)).filter((key) => chains[key]);
  console.log('Chain'.padEnd(12) + 'RPC host'.padEnd(36) + 'median'.padStart(8) + 'worst'.padStart(8) + 'block age'.padStart(11) + '  note');
  for (const key of keys) {
    for (const url of chains[key].rpcUrls) {
      const times = []; const ages = []; let failure = '';
      for (let i = 0; i < ROUNDS; i += 1) {
        try { const r = await latest(url); times.push(r.ms); ages.push(r.ageSec); } catch (e) { failure = String(e.message).slice(0, 40); }
      }
      const notes = [];
      if (url === chains[key].defaultRpc) notes.push('free public endpoint');
      if (failure) notes.push(`${ROUNDS - times.length}/${ROUNDS} failed: ${failure}`);
      if (times.length && median(times) > 300) notes.push('slow');
      const line = key.padEnd(12) + host(url).slice(0, 34).padEnd(36);
      console.log(times.length
        ? `${line}${`${Math.round(median(times))} ms`.padStart(8)}${`${Math.round(Math.max(...times))} ms`.padStart(8)}${`${Math.max(...ages)} s`.padStart(11)}  ${notes.join('; ')}`
        : `${line}${'FAIL'.padStart(8)}${''.padStart(8)}${''.padStart(11)}  ${notes.join('; ')}`);
    }
  }
  console.log('\nGood: median under ~150 ms, worst under ~500 ms. Block age should stay near the chain\'s block time (about 2 s on most L2s, up to 12 s on Ethereum); a larger gap means the node lags behind the chain.');
})().catch((e) => { console.error(e.message); process.exit(1); });
