'use strict';
// Launch engine (docs/adr/0005-launch-engine.md).
//
// For every schedule inside [T − LAUNCH_ARM_SECONDS, T + LAUNCH_HOT_WINDOW_SECONDS] one in-process session:
//   1. ARM     prepare, check and pre-sign before the opening (fastExecution.arm). Retries every few
//              seconds until the fire time if the RPC fails or the wallet is short of funds.
//   2. WAIT    sleep to the fire time on a millisecond timer; ~1.5 s before it, warm every RPC connection.
//   3. FIRE    broadcast the pre-signed bytes to every endpoint at once (fastExecution.fire). Mints that
//              cannot be pre-signed (OpenSea API, dry run) are built and sent directly at the fire time.
//   4. FOLLOW  timing failures retry within LAUNCH_RETRY_INTERVAL_MS (a cheap eth_call probe first, then a
//              full send the moment it passes); the receipt is polled every LAUNCH_RECEIPT_POLL_MS and an
//              on-chain revert is re-signed with a fresh nonce immediately (at most LAUNCH_MAX_CHAIN_RETRIES).
// After the hot window, or for anything that is not about timing (funds, API back-off), the session hands
// the schedule back to the worker tick, which behaves exactly as before.
//
// A session holds the wallet's durable execution lease for its whole life, so no other worker or tick can
// sign for that wallet meanwhile (one nonce stream per wallet).
const { OUTCOME } = require('./core/outcomes');
const { ARM, launchTarget } = require('./core/fastExecution');
const { getSchedule, scheduleDeadline } = require('./core/schedules');
const { trackedByHash } = require('./core/tracking');
const { withRpcPriority } = require('./core/rpc');

const ARM_LEAD_MIN_MS = 300;   // closer than this to the fire time, send directly instead of arming
const WARM_LEAD_MS = 1500;     // open RPC connections this long before the fire time
const MAX_FAST_RETRIES = 8;    // transient (RPC) failures retried inside the hot window before handing back

// Not unref'd: a session waiting for its fire time must keep the process alive.
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, Math.max(0, ms)); });

function createLaunchEngine({
  db, cfg, chains, rpc, fastExecution, withWalletLease, applyOutcome, settleReceipt, notifyOnce,
  log = console, nowMs = () => Date.now(), sleep = defaultSleep
}) {
  const L = cfg.launch;
  const maxWaitSec = L.maxWaitSec;
  const sessions = new Map();     // scheduleId -> { promise, control }
  const watching = new Set();     // tx hashes a session is polling (the tick leaves them alone)
  let stopped = false;

  const nowSec = () => Math.floor(nowMs() / 1000);
  const active = (id) => { const s = getSchedule(db, id); return s && ['scheduled', 'ready'].includes(s.status) ? s : null; };

  function enabled() { return L.engine !== false && Boolean(fastExecution && typeof fastExecution.execute === 'function'); }

  /** Inside [T − armSec, T + hotWindowSec] on the local clock. */
  function inWindow(s, tMs = nowMs()) {
    const T = Number(launchTarget(s)) * 1000;
    return tMs >= T - L.armSec * 1000 && tMs <= T + L.hotWindowSec * 1000;
  }

  function has(id) { return sessions.has(id); }
  function isWatching(hash) { return watching.has(String(hash).toLowerCase()); }

  /** Start a session for a candidate schedule. Returns false when one is running or the limit is reached. */
  function start(s) {
    if (!enabled() || stopped || sessions.has(s.id)) return false;
    if (sessions.size >= L.maxSessions) { log.warn?.('launch session limit reached; schedule left to the tick', { scheduleId: s.id }); return false; }
    const control = { aborted: false };
    // Every RPC read of a launch session (arming, probes, receipts) jumps the endpoint queues.
    const promise = withRpcPriority('high', async () => {
      try {
        const ran = await withWalletLease(s.wallet_address, (lease) => run(s.id, lease, control));
        if (ran === false) log.info?.('launch session deferred: wallet lease busy', { scheduleId: s.id });
      } catch (e) {
        log.error?.('launch session failed', { scheduleId: s.id, error: e?.message });
      } finally {
        sessions.delete(s.id);
      }
    });
    sessions.set(s.id, { promise, control });
    return true;
  }

  async function sleepUntil(targetMs, ctx) {
    while (ctx.alive()) {
      const left = targetMs - nowMs();
      if (left <= 0) return true;
      await sleep(Math.min(left, 1000)); // wake at least every second to notice stop/cancel
    }
    return false;
  }
  const sleepFor = (ms, ctx) => sleepUntil(nowMs() + ms, ctx);

  const apply = (s, r) => applyOutcome(s, r, nowSec());

  async function run(id, lease, control) {
    const s0 = active(id);
    if (!s0) return;
    const ctx = {
      id, lease, control, timingWait: false, effectiveT: Number(launchTarget(s0)),
      alive: () => !control.aborted && !stopped && lease.isOwned()
    };
    let fireAt = ctx.effectiveT * 1000 + L.fireOffsetMs;
    let armedAttempt = null;

    const existing = fastExecution.openAttempt ? fastExecution.openAttempt(id) : null;
    if (existing && existing.status === 'armed') {
      armedAttempt = existing; // recovered after a restart: fire at its recorded time (or now)
      fireAt = Number(existing.fire_at_ms);
    } else if (existing) {
      // A transaction may already exist: reconcile it by hash, never sign another.
      return followUp(ctx, await fastExecution.execute(s0, { assertLock: lease.isOwned, deadline: scheduleDeadline(s0, maxWaitSec) }));
    } else if (nowMs() < fireAt - ARM_LEAD_MIN_MS && typeof fastExecution.arm === 'function') {
      const armed = await armPhase(ctx, fireAt);
      if (armed.done) return;
      if (armed.attempt) { armedAttempt = armed.attempt; fireAt = Number(armed.fireAtMs); }
      else if (armed.fireAtMs != null) fireAt = armed.fireAtMs;
    }
    // A SeaDrop stage start later than the schedule moves the fire time; the hot window follows it.
    if (armedAttempt) ctx.effectiveT = Math.max(ctx.effectiveT, Math.floor((fireAt - L.fireOffsetMs) / 1000));

    // Warm every RPC connection shortly before the fire time, then wait for it.
    if (fireAt - nowMs() > WARM_LEAD_MS) {
      if (!await sleepUntil(fireAt - WARM_LEAD_MS, ctx)) return;
      if (typeof rpc.warm === 'function') rpc.warm(s0.chain).catch(() => {});
    }
    if (!await sleepUntil(fireAt, ctx)) return;
    const s = active(id);
    if (!s) return; // cancelled or expired while waiting; an armed attempt is never fired for it

    const first = armedAttempt
      ? await fastExecution.fire(armedAttempt, s, { assertLock: lease.isOwned })
      : await fastExecution.execute(s, { assertLock: lease.isOwned, deadline: scheduleDeadline(s, maxWaitSec) });
    return followUp(ctx, first);
  }

  /** Keep trying to pre-sign until shortly before the fire time. */
  async function armPhase(ctx, fireAt) {
    let tries = 0;
    while (ctx.alive() && nowMs() < fireAt - ARM_LEAD_MIN_MS) {
      const s = active(ctx.id);
      if (!s) return { done: true };
      let r;
      try { r = await fastExecution.arm(s, { assertLock: ctx.lease.isOwned }); }
      catch (e) {
        log.error?.('arming failed unexpectedly', { scheduleId: s.id, error: e?.message });
        r = { outcome: OUTCOME.RETRY, userReason: 'Unexpected error while arming.' };
      }
      switch (r.outcome) {
        case ARM.ARMED:
          followChainStart(s, r.chainStart);
          notifyOnce(s, 'armed', `🎯 Mint for schedule #${s.id} is pre-signed and armed. It will be sent at ${new Date(Math.round(r.fireAtMs)).toISOString().replace('T', ' ').replace('Z', ' UTC')}.`);
          return { attempt: r.attempt, fireAtMs: r.fireAtMs };
        case ARM.EXISTING:
          return r.attempt && r.attempt.status === 'armed' ? { attempt: r.attempt, fireAtMs: Number(r.attempt.fire_at_ms) } : { fireAtMs: nowMs() };
        case ARM.OPEN_NOW:
          return { fireAtMs: nowMs() };
        case ARM.NOT_ARMABLE:
          return {};
        case OUTCOME.WAIT:
          if (r.notify === 'funds') { notifyFunds(s, r); break; } // keep re-arming: the user may top up in time
          followChainStart(s, r.chainStart);
          apply(s, r); // SeaDrop says the stage opens later: deferred to just before it, then armed again
          return { done: true };
        case OUTCOME.RETRY:
        case OUTCOME.UNCERTAIN:
          break;
        default: // TERMINAL, DRY_RUN, LEASE_LOST
          apply(s, r);
          return { done: true };
      }
      tries += 1;
      const pause = Math.min(5000, 500 * 2 ** Math.min(tries, 4));
      if (nowMs() + pause >= fireAt - ARM_LEAD_MIN_MS) break;
      await sleepFor(pause, ctx);
    }
    return {};
  }

  /**
   * Launch mode means "when it opens". When SeaDrop's NotActive names the stage start, that IS the
   * opening: record it, so the arming window, hot window, grace period and deadline all follow the chain.
   * Manual-time schedules keep the user's time.
   */
  function followChainStart(s, chainStart) {
    const start = Number(chainStart);
    if (s.trigger_mode !== 'launch' || !Number.isInteger(start) || start <= 0 || start === Number(s.launch_at)) return;
    db.prepare("UPDATE schedules SET launch_at=? WHERE id=? AND status IN ('scheduled','ready')").run(start, s.id);
    log.info?.('launch time follows the on-chain stage start', { scheduleId: s.id, from: s.launch_at, to: start });
  }

  function notifyFunds(s, r) {
    const chain = chains[s.chain];
    notifyOnce(s, 'funds', `💸 Schedule #${s.id}: ${r.userReason}\nWallet: <code>${s.wallet_address}</code> on ${chain ? chain.name : s.chain}. MintPilot keeps trying through the launch.`);
  }

  /** Re-check the schedule and send: a one-call probe first while the stage is still closed. */
  async function sendNow(ctx) {
    const s = active(ctx.id);
    if (!s || !ctx.alive()) return { outcome: OUTCOME.LEASE_LOST, userReason: null };
    if (ctx.timingWait && typeof fastExecution.probe === 'function' && !(fastExecution.usesSendTimeApi && fastExecution.usesSendTimeApi(s))) {
      const p = await fastExecution.probe(s);
      if (!p.open) return p;
    }
    return fastExecution.execute(s, { assertLock: ctx.lease.isOwned, deadline: scheduleDeadline(s, maxWaitSec) });
  }

  const hotEndMs = (ctx) => ctx.effectiveT * 1000 + L.hotWindowSec * 1000;
  // Waiting for an OpenSea stage to open can go on longer than the hot window; it only needs a cheap read each time.
  const canWatchOpenSea = typeof fastExecution.probeOpenSea === 'function';
  const watchEndMs = (ctx) => ctx.effectiveT * 1000 + Math.max(L.hotWindowSec, L.openSeaWaitSec) * 1000;

  async function followUp(ctx, first) {
    let r = first;
    let transient = 0;
    let immediate = 0;
    let apiWaits = 0;
    while (true) {
      const s = getSchedule(db, ctx.id);
      if (!s) return;
      if (!r) r = { outcome: OUTCOME.RETRY, userReason: 'Unexpected empty result; retrying.' };
      if (r.outcome === OUTCOME.SUBMITTED) {
        apply(s, r);
        ctx.timingWait = false;
        if (!r.txHash) return;
        const watched = await watch(ctx, s.chain, r.txHash);
        if (watched !== 'requeued' || !ctx.alive()) return;
        r = await sendNow(ctx); // reverted on-chain: re-sign with a fresh nonce right now
        continue;
      }
      const inHot = nowMs() <= hotEndMs(ctx);
      if (r.outcome === OUTCOME.WAIT && r.armed) {
        if (!await sleepUntil(Number(r.fireAtMs), ctx)) return;
        r = await sendNow(ctx);
        continue;
      }
      if (r.outcome === OUTCOME.WAIT && r.timing && inHot) {
        // Not open yet: probe again within milliseconds, or exactly at the stage start SeaDrop reported.
        ctx.timingWait = true;
        const at = Math.max(nowMs() + L.retryIntervalMs, r.retryAt ? Number(r.retryAt) * 1000 + L.fireOffsetMs : 0);
        if (!await sleepUntil(at, ctx)) return;
        r = await sendNow(ctx);
        continue;
      }
      if (r.outcome === OUTCOME.WAIT && r.apiCost && !r.notify && (canWatchOpenSea ? nowMs() <= watchEndMs(ctx) : inHot)) {
        apiWaits += 1;
        // Tell the user right away instead of leaving them wondering.
        if (r.inactive) notifyOnce(s, 'inactive', `⏳ Schedule #${s.id}: OpenSea says this mint is not open yet, so nothing was sent.\nMintPilot keeps checking every few seconds and goes ahead the moment it opens. If it sells out first, I will tell you.\nIf you set this time earlier than the real mint time, cancel it in /mints and schedule again for the real opening time.`);
        const retryAfterMs = Number(r.retryAfterSec || 0) * 1000;
        let live = null;
        if (canWatchOpenSea) {
          // Watch with a cheap read; the mint request is only sent once the stage is live (or the state cannot be read).
          if (!await sleepFor(Math.max(retryAfterMs, apiWaits === 1 ? 1000 : L.openSeaPollMs), ctx)) return;
          const current = active(ctx.id);
          if (!current) return;
          live = await fastExecution.probeOpenSea(current);
          if (live === false) continue;
        }
        if (live === null) {
          // Cannot read the drop: keep the original pacing (1, 2, 4, 8 s) inside the hot window, then hand over to the worker.
          if (!inHot) { apply(s, r); return; }
          if (!canWatchOpenSea) {
            const pause = Math.max(retryAfterMs, Math.min(8000, 1000 * 2 ** (apiWaits - 1)));
            if (!await sleepFor(pause, ctx)) return;
          }
        }
        r = await sendNow(ctx);
        continue;
      }
      if (r.outcome === OUTCOME.RETRY && inHot && (r.immediate ? immediate < MAX_FAST_RETRIES : transient < MAX_FAST_RETRIES)) {
        log.warn?.('mint attempt will retry', { scheduleId: s.id, chain: s.chain, reason: r.userReason });
        if (r.immediate) immediate += 1;
        else {
          transient += 1;
          const pause = Math.max(Number(r.retryAfterSec || 0) * 1000, Math.min(2000, L.retryIntervalMs * 2 ** (transient - 1)));
          if (!await sleepFor(pause, ctx)) return;
        }
        r = await sendNow(ctx);
        continue;
      }
      if (r.outcome === OUTCOME.UNCERTAIN && r.txHash && inHot) {
        // The transaction may exist: watch its hash; a receipt settles it either way.
        const watched = await watch(ctx, s.chain, r.txHash);
        if (watched === 'requeued' && ctx.alive()) { r = await sendNow(ctx); continue; }
        if (watched !== 'timeout') return;
      }
      // Funds, terminal, dry run, lease lost, or the hot window is over: the worker tick takes it from here.
      if (r.outcome !== OUTCOME.LEASE_LOST) apply(s, r);
      return;
    }
  }

  /**
   * Poll the receipt quickly. Returns 'requeued' when the mint reverted and the schedule was put back
   * for an immediate re-sign, 'settled' once the receipt is recorded, 'timeout' after the watch window
   * (the tick keeps tracking it), or 'stopped'.
   */
  async function watch(ctx, chainKey, hash) {
    const key = String(hash).toLowerCase();
    const chain = chains[chainKey];
    watching.add(key);
    try {
      const until = nowMs() + L.receiptWatchSec * 1000;
      while (nowMs() < until) {
        if (!await sleepFor(L.receiptPollMs, ctx)) return 'stopped';
        let receipt;
        try { receipt = await rpc.getReceipt(chainKey, hash); } catch { continue; }
        if (!receipt || receipt.confirmations < (chain ? chain.confirmations : 1)) continue;
        const row = trackedByHash(db, chainKey, key);
        if (!row) return 'settled';
        const out = await settleReceipt(row, receipt);
        if (out && out.requeued) return 'requeued';
        return 'settled';
      }
      return 'timeout';
    } finally {
      watching.delete(key);
    }
  }

  /** Resolves when every running session has finished (tests, graceful shutdown). */
  async function idle() {
    while (sessions.size) await Promise.allSettled([...sessions.values()].map((x) => x.promise));
  }

  function stop() {
    stopped = true;
    for (const { control } of sessions.values()) control.aborted = true;
  }

  return { enabled, inWindow, has, start, isWatching, idle, stop, sessions: () => sessions.size };
}

module.exports = { createLaunchEngine, ARM_LEAD_MIN_MS, WARM_LEAD_MS };
