'use strict';
// Gas limit policy for automatically signed mints.
//   gasLimit = ceil(estimate × multiplier)
//   cap      = base + perToken × (quantity − 1)
// base/perToken are GAS_CAP_BASE / GAS_CAP_PER_TOKEN, overridden per chain by GAS_CAP_JSON.
// An estimate above the cap is refused: it usually means the call is not the mint we expect,
// or that the caps need calibrating for this chain (Arbitrum One and Orbit chains such as
// Robinhood Chain include parent-chain data cost in their gas estimates). Calibrate from the
// "gas used" figures of real mainnet mints (docs/RUNBOOK.md, timing report).

function gasCap(cfg, quantity, chainKey = null) {
  const q = BigInt(Math.max(1, Number(quantity) || 1));
  const override = (chainKey && cfg.gas.byChain && cfg.gas.byChain[chainKey]) || {};
  const base = override.base ?? cfg.gas.capBase;
  const perToken = override.perToken ?? cfg.gas.capPerToken;
  return BigInt(base) + BigInt(perToken) * (q - 1n);
}

function gasLimitFor(cfg, estimate, quantity, chainKey = null) {
  const est = BigInt(estimate);
  const cap = gasCap(cfg, quantity, chainKey);
  if (est > cap) return { ok: false, estimate: est, cap, gasLimit: null };
  const bps = BigInt(cfg.gas.estimateMultiplierBps);
  const padded = (est * bps + 9999n) / 10000n; // ceil
  return { ok: true, estimate: est, cap, gasLimit: padded > cap ? cap : padded };
}

module.exports = { gasCap, gasLimitFor };
