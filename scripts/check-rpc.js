'use strict';
// Verifies every configured RPC endpoint serves the expected chain id, in parallel. Run before launch:
//   npm run check:rpc
const { loadConfig } = require('../src/config');
const { getChains } = require('../src/chains');
const { createRpc } = require('../src/core/rpc');
(async () => {
  const cfg = loadConfig();
  const chains = getChains(cfg);
  const rpc = createRpc(chains, { ...cfg.rpc, log: { warn() {}, info() {}, error() {} } });
  const rows = await Promise.all(Object.values(chains).map(async (c) => {
    const started = Date.now();
    try {
      await rpc.provider(c.key);
      const live = rpc.health(c.key).filter((e) => e.verified && !e.disabled).map((e) => e.host);
      return { ok: true, line: `OK    ${c.name} (${c.chainId}) ${Date.now() - started} ms via ${live.join(', ') || 'configured RPC'}${c.rpcUrl === c.defaultRpc ? '  [public default RPC: rate limited]' : ''}` };
    } catch (e) { return { ok: false, line: `FAIL  ${c.name} (${c.chainId}): ${e.message}` }; }
  }));
  rows.forEach((r) => console.log(r.line));
  const allowed = new Set(cfg.automation.allowedChains);
  const failedAllowed = rows.filter((r, i) => !r.ok && allowed.has(Object.keys(chains)[i])).length;
  process.exit(failedAllowed ? 1 : 0);
})();
