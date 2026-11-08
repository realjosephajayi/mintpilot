'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUnits } = require('ethers');
const { makeCfg, getChains } = require('./helpers');
const { feeFields, tipFor, txFeeFields } = require('../../src/core/feePolicy');
const { fireAtMs, clockLagMs, landedAfterSec } = require('../../src/core/launchTiming');

test('fee policy: no tip on first-come-first-served Robinhood, RPC tip elsewhere, operator override wins', () => {
  const cfg = makeCfg();
  const chains = getChains(cfg);
  assert.equal(chains.robinhood.ordering, 'fcfs');
  assert.equal(chains.base.ordering, 'fee');
  assert.equal(tipFor(chains.robinhood, cfg, 5n), 0n, 'a tip buys nothing on an FCFS sequencer');
  assert.equal(tipFor(chains.base, cfg, 5n), 5n);
  assert.equal(tipFor(chains.base, cfg, null), 0n);
  const overridden = { ...cfg, fees: { ...cfg.fees, priorityFeeGwei: { robinhood: '0.01', base: 0 } } };
  assert.equal(tipFor(chains.robinhood, overridden, null), parseUnits('0.01', 'gwei'));
  assert.equal(tipFor(chains.base, overridden, 5n), 0n);
});

test('fee policy: max fee = ceil(base × multiplier) + tip; legacy chains use gasPrice', () => {
  const cfg = makeCfg();
  const chains = getChains(cfg);
  const direct = feeFields(chains.base, cfg, { baseFeePerGas: 1001n, priorityFeePerGas: 7n });
  assert.deepEqual(direct, { type: 2, maxFeePerGas: 2002n + 7n, maxPriorityFeePerGas: 7n, maxCost: 2009n });
  const armed = feeFields(chains.robinhood, cfg, { baseFeePerGas: 10_000_000n, priorityFeePerGas: 99n }, 30000);
  assert.equal(armed.maxFeePerGas, 30_000_000n);
  assert.equal(armed.maxPriorityFeePerGas, 0n);
  assert.deepEqual(txFeeFields(armed), { type: 2, maxFeePerGas: 30_000_000n, maxPriorityFeePerGas: 0n });
  assert.deepEqual(feeFields(chains.base, cfg, { baseFeePerGas: null, gasPrice: 55n }), { type: 0, gasPrice: 55n, maxCost: 55n });
  assert.throws(() => feeFields(chains.base, cfg, { baseFeePerGas: null, gasPrice: null }), /Fee data unavailable/);
});

test('fire time: T + offset; launch mode follows the decoded SeaDrop start, manual mode never fires early', () => {
  assert.equal(fireAtMs({ launchAtSec: 100, offsetMs: 50 }), 100_050);
  assert.equal(fireAtMs({ launchAtSec: 100, chainStartSec: 130, triggerMode: 'launch', offsetMs: 50 }), 130_050);
  assert.equal(fireAtMs({ launchAtSec: 100, chainStartSec: 90, triggerMode: 'launch', offsetMs: 0 }), 90_000, 'the chain says it opens earlier');
  assert.equal(fireAtMs({ launchAtSec: 100, chainStartSec: 90, triggerMode: 'manual', offsetMs: 0 }), 100_000, 'manual time is a floor');
  assert.equal(fireAtMs({ launchAtSec: 100, chainStartSec: 130, triggerMode: 'manual', offsetMs: 0 }), 130_000);
  assert.equal(fireAtMs({ launchAtSec: 100, offsetMs: 50, lagMs: 3000 }), 97_050, 'a server clock 3 s behind the chain fires 3 s earlier locally');
  assert.equal(fireAtMs({ launchAtSec: 100, offsetMs: -200 }), 99_800);
});

test('clock lag: only a block timestamp more than a second ahead of the local clock proves lag', () => {
  assert.equal(clockLagMs(100, 100_400), 0, 'block timestamps lag real time; nothing to correct');
  assert.equal(clockLagMs(101, 100_400), 0, 'under one second is rounding');
  assert.equal(clockLagMs(103, 100_400), 2600);
  assert.equal(landedAfterSec(100, 100), 0);
  assert.equal(landedAfterSec(103, 100), 3);
  assert.equal(landedAfterSec(null, 100), null);
});
