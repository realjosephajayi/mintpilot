'use strict';
// When exactly to broadcast a launch mint. Pure functions; times are local milliseconds unless named Sec.
//
// The chain decides whether a mint is open by its block timestamp (whole seconds). On a fast
// first-come-first-served chain (Robinhood: ~100 ms blocks) the winning move is to reach the sequencer
// right after the opening second begins. MintPilot fires at T + LAUNCH_FIRE_OFFSET_MS on the server
// clock, corrected when a block timestamp proves the server clock is behind the chain.

/**
 * Local fire time in ms.
 * - launchAtSec: the schedule's opening (launch mode) or chosen time (manual mode).
 * - chainStartSec: the stage start decoded from a SeaDrop NotActive revert, when known. It is the
 *   chain's own opening time, so launch mode follows it; manual mode never fires before the chosen time.
 * - lagMs: how far the local clock is behind the chain (see clockLagMs).
 */
function fireAtMs({ launchAtSec, chainStartSec = null, triggerMode = 'launch', offsetMs = 0, lagMs = 0 }) {
  let target = Number(launchAtSec);
  const start = chainStartSec == null ? NaN : Number(chainStartSec);
  if (Number.isFinite(start) && start > 0) target = triggerMode === 'launch' ? start : Math.max(target, start);
  return target * 1000 + Number(offsetMs || 0) - Number(lagMs || 0);
}

/**
 * Lower bound on how far the local clock is BEHIND the chain, in ms, from a recent block timestamp.
 * Block timestamps are whole seconds and never ahead of the chain's clock, so a lag under one second
 * is indistinguishable from rounding and is reported as 0. A local clock running AHEAD of the chain
 * cannot be detected this way; firing early then costs at most a cheap revert followed by an immediate retry.
 */
function clockLagMs(blockTimestampSec, localMs) {
  const lag = Number(blockTimestampSec) * 1000 - Number(localMs);
  return lag > 1000 ? Math.floor(lag) : 0;
}

/** Seconds (block timestamp) after the opening at which a transaction landed; null when unknown. */
function landedAfterSec(includedAtSec, launchAtSec) {
  if (includedAtSec == null || launchAtSec == null) return null;
  return Number(includedAtSec) - Number(launchAtSec);
}

module.exports = { fireAtMs, clockLagMs, landedAfterSec };
