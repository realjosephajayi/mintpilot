'use strict';
// Background loop: automatic mint execution, pre-mint alerts, expiry and transaction tracking.
// MintPilot only signs automatically; there is no manual signing link.
//
// Schedules inside their launch window [T − LAUNCH_ARM_SECONDS, T + LAUNCH_HOT_WINDOW_SECONDS] are run by
// the launch engine (src/launchEngine.js): pre-signed, fired on a millisecond timer, retried within
// milliseconds. Everything else (late schedules, funds waits, API back-off) runs on this tick as before.
const { reminderCandidates, completeReminder, claimReminder, expireStale, scheduleDeadline, deferSchedule, failSchedule, getSchedule, requeueAfterRevert } = require('./core/schedules');
const { pendingTxs, finishTx, addTrackedTx } = require('./core/tracking');
const { listWallets } = require('./core/wallets');
const { rewardReferral } = require('./core/referrals');
const { tx } = require('./db');
const { txUrl } = require('./chains');
const { esc, shortAddr, formatWei, utc } = require('./util/format');
const { createWalletExecutionLocks } = require('./core/walletExecutionLocks');
const { OUTCOME, backoffSec } = require('./core/outcomes');
const { launchTarget } = require('./core/fastExecution');
const { landedAfterSec } = require('./core/launchTiming');
const { createLaunchEngine } = require('./launchEngine');
const { withRpcPriority } = require('./core/rpc');

const DROP_AFTER_SEC = 24 * 3600;
const UNCERTAIN_RECHECK_SEC = 30;

function createWalletExecutionQueue(concurrency = 4) {
  const limit = Number.isInteger(concurrency) ? Math.max(1, Math.min(16, concurrency)) : 4;
  const tails = new Map();
  const waiters = [];
  let active = 0;
  async function withSlot(task) {
    if (active < limit) active += 1;
    else await new Promise((resolve) => waiters.push(resolve));
    try { return await task(); }
    finally {
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
    }
  }
  return function runForWallet(walletAddress, task) {
    const key = String(walletAddress || 'unknown').toLowerCase();
    const previous = tails.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => withSlot(task));
    tails.set(key, current);
    return current.finally(() => {
      if (tails.get(key) === current) tails.delete(key);
    });
  };
}

function createWorker({
  db, cfg, tg, rpc, chains, fastExecution,
  maxConcurrentWallets = cfg.automation?.maxConcurrentWallets ?? 4,
  now = null, nowMs = null, sleep = undefined, log = console
}) {
  const clockMs = nowMs || (now ? () => now() * 1000 : () => Date.now());
  const nowSec = now || (() => Math.floor(clockMs() / 1000));
  const runForWallet = createWalletExecutionQueue(maxConcurrentWallets);
  const walletLocks = createWalletExecutionLocks({ db, ttlSec: cfg.automation?.walletLockTtlSec ?? 120, now: nowSec });
  const maxWaitSec = cfg.launch?.maxWaitSec ?? 21600;
  const armSec = cfg.launch?.armSec ?? 60;
  const trackingConcurrency = cfg.trackingConcurrency ?? 8;
  const maxChainRetries = cfg.launch?.maxChainRetries ?? 3;

  async function safeSend(telegramId, text, extra) {
    try { await tg.sendMessage(telegramId, text, extra); return true; }
    catch (e) {
      if (e.blocked) db.prepare('UPDATE users SET blocked_bot=1 WHERE telegram_id=?').run(String(telegramId));
      else log.error('send failed', telegramId, e.message);
      return e.blocked ? 'blocked' : false;
    }
  }

  function notifyLater(telegramId, text, extra) {
    setImmediate(() => { safeSend(telegramId, text, extra).catch((e) => log.error('async notification failed', e.message)); });
  }

  /** At most one message per (schedule, kind): reminders_sent's primary key makes this durable. */
  function notifyOnce(s, kind, text, t = nowSec()) {
    if (completeReminder(db, s.id, `notify:${kind}`, t)) notifyLater(s.telegram_id, text);
  }

  async function withWalletLease(walletAddress, task) {
    const lock = walletLocks.acquire(walletAddress);
    if (!lock) {
      if (log && typeof log.info === 'function') log.info('wallet execution lease busy; candidate deferred', { wallet: shortAddr(walletAddress) });
      return false;
    }
    let owned = true;
    const heartbeatMs = Math.max(1000, Math.floor(walletLocks.ttlSec * 1000 / 3));
    const heartbeat = setInterval(() => {
      try {
        if (!walletLocks.renew(lock)) {
          owned = false;
          clearInterval(heartbeat);
          if (log && typeof log.error === 'function') log.error('wallet execution lease lost', { wallet: shortAddr(walletAddress) });
        }
      } catch (e) {
        owned = false;
        clearInterval(heartbeat);
        if (log && typeof log.error === 'function') log.error('wallet execution lease renewal failed', { wallet: shortAddr(walletAddress), error: e.message });
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    try {
      return await task({ isOwned: () => owned && walletLocks.owns(lock) });
    } finally {
      clearInterval(heartbeat);
      if (!walletLocks.release(lock) && log && typeof log.warn === 'function') log.warn('wallet execution lease was not released by its owner', { wallet: shortAddr(walletAddress) });
    }
  }

  const label = (s) => `schedule #${s.id}`;

  /** Apply an executor outcome to the schedule. The only place schedule state changes after execution. */
  function applyOutcome(s, result, t) {
    const chain = chains[s.chain];
    const reason = result.userReason ? esc(result.userReason) : '';
    switch (result.outcome) {
      case OUTCOME.SUBMITTED: {
        try {
          tx(db, () => {
            addTrackedTx(db, cfg, { telegramId: s.telegram_id, chain: s.chain, txHash: result.txHash, scheduleId: s.id, system: true }, t);
            db.prepare("UPDATE schedules SET status='submitted', tx_hash=?, last_error=NULL WHERE id=? AND status IN ('scheduled','ready')").run(result.txHash.toLowerCase(), s.id);
          });
        } catch (e) {
          log.error('submitted transaction could not be recorded', s.id, e.message);
          return;
        }
        completeReminder(db, s.id, 'due', t);
        const retry = Number(s.chain_retries) || 0;
        const link = chain ? txUrl(chain, result.txHash) : esc(result.txHash);
        notifyOnce(s, retry ? `submitted:${retry}` : 'submitted', retry
          ? `🔁 Retry ${retry}: mint for ${label(s)} re-signed and sent on ${esc(chain ? chain.name : s.chain)}.\n${link}`
          : `🚀 Mint for ${label(s)} signed and sent on ${esc(chain ? chain.name : s.chain)}.\n${link}`, t);
        return;
      }
      case OUTCOME.WAIT:
      case OUTCOME.RETRY: {
        // RETRY and API-costly waits (OpenSea) back off exponentially. A chain-side WAIT ("not open yet",
        // "top up the wallet") polls every tick so a launch is never missed by minutes; a SeaDrop
        // NotActive revert names the stage start, so the next attempt is aimed exactly at it.
        const backoff = result.outcome === OUTCOME.RETRY || result.apiCost;
        const nextAttemptAt = backoff ? t + backoffSec(s.attempts, result.retryAfterSec) : Math.max(t, Number(result.retryAt) || 0);
        deferSchedule(db, s.id, { nextAttemptAt, lastError: result.userReason || null, attempts: backoff ? 'increment' : 'reset' });
        if (result.inactive) notifyOnce(s, 'inactive', `⏳ ${label(s)}: OpenSea says this mint is not open yet, so nothing was sent.\nMintPilot keeps checking and goes ahead as soon as it opens, until ${utc(scheduleDeadline(s, maxWaitSec))}. If it sells out first, I will tell you.\nIf you set this time earlier than the real mint time, cancel it in /mints and schedule again for the real opening time.`, t);
        if (result.notify === 'funds') notifyOnce(s, 'funds', `💸 ${label(s)}: ${reason}\nWallet: <code>${s.wallet_address}</code> on ${esc(chain ? chain.name : s.chain)}. MintPilot keeps trying until ${utc(scheduleDeadline(s, maxWaitSec))}.`, t);
        return;
      }
      case OUTCOME.UNCERTAIN: {
        deferSchedule(db, s.id, { nextAttemptAt: t + UNCERTAIN_RECHECK_SEC, lastError: result.userReason || null, attempts: 'keep' });
        notifyOnce(s, 'uncertain', `⏳ ${label(s)}: ${reason}${result.txHash && chain ? `\n${txUrl(chain, result.txHash)}` : ''}`, t);
        return;
      }
      case OUTCOME.TERMINAL: {
        if (failSchedule(db, s.id, result.userReason || 'automatic execution stopped')) {
          completeReminder(db, s.id, 'due', t);
          notifyOnce(s, 'terminal', `❌ ${label(s)} stopped: ${reason || 'automatic execution cannot continue'}\nNo transaction was sent for this attempt.`, t);
        }
        return;
      }
      case OUTCOME.DRY_RUN: {
        db.prepare("UPDATE schedules SET status='ready', last_error=? WHERE id=? AND status='scheduled'").run(result.userReason || 'dry run', s.id);
        completeReminder(db, s.id, 'due', t);
        notifyOnce(s, 'dry-run', `🧪 ${label(s)}: ${reason}`, t);
        return;
      }
      case OUTCOME.LEASE_LOST:
      default:
        return; // another worker owns the wallet now; it will handle the schedule
    }
  }

  /** Record where an attempt landed (block, gas used, block time) for the latency report. */
  function recordInclusion(scheduleId, hash, receipt, status, error = null) {
    const t = nowSec();
    db.prepare(`UPDATE execution_attempts SET status=?, error=COALESCE(?, error), included_block=?, gas_used=?, updated_at=?, resolved_at=?
      WHERE schedule_id=? AND lower(tx_hash)=? AND status IN ('submitting','uncertain','submitted')`)
      .run(status, error, receipt.blockNumber ?? null, receipt.gasUsed == null ? null : Number(receipt.gasUsed), t, t, scheduleId, String(hash).toLowerCase());
  }

  async function blockTime(chainKey, blockNumber) {
    if (typeof rpc.getBlockTimestamp !== 'function' || blockNumber == null) return null;
    try { return await rpc.getBlockTimestamp(chainKey, blockNumber); } catch { return null; }
  }

  function landingLine(attempt, includedAt) {
    if (!attempt || attempt.launch_at == null || includedAt == null) return '';
    const d = landedAfterSec(includedAt, attempt.launch_at);
    if (d == null || d < 0) return '';
    return `\n⏱ Landed ${d === 0 ? 'in the opening second' : `${d}s after the opening`}${attempt.fire_at_ms ? ' (pre-signed)' : ''}.`;
  }

  /**
   * Settle one receipt. Shared by the tick and the launch engine; the atomic finishTx claim means only
   * one caller acts on it. A scheduled mint that reverted on-chain is put back for an immediate re-sign
   * (fresh nonce) while its window is open and LAUNCH_MAX_CHAIN_RETRIES lasts.
   */
  async function settleReceipt(row, r, t = nowSec()) {
    const chain = chains[row.chain];
    const sched = row.schedule_id ? getSchedule(db, row.schedule_id) : null;
    const wallets = sched ? [sched.wallet_address] : listWallets(db, row.telegram_id).map((w) => w.address);
    const tokenIds = r.status === 'confirmed' ? rpc.parseReceivedTokenIds(r.logs, wallets) : [];
    if (!finishTx(db, row.id, { status: r.status, blockNumber: r.blockNumber, tokenIds })) return { settled: false };

    if (sched && r.status === 'failed' && sched.status === 'submitted') {
      recordInclusion(sched.id, row.tx_hash, r, 'failed', 'reverted on-chain');
      const retry = requeueAfterRevert(db, sched.id, { now: t, maxRetries: maxChainRetries, deadline: scheduleDeadline(sched, maxWaitSec) });
      if (retry != null) {
        notifyOnce(sched, `revert-retry:${retry}`, `⚡ ${label(sched)}: the mint reverted on-chain (block ${r.blockNumber}). MintPilot is re-signing and sending again now (retry ${retry} of ${maxChainRetries}).\n${txUrl(chain, row.tx_hash)}`, t);
        // Telemetry only: never delays the re-sign.
        blockTime(row.chain, r.blockNumber).then((ts) => { if (ts != null) db.prepare('UPDATE execution_attempts SET included_at=? WHERE lower(tx_hash)=?').run(ts, String(row.tx_hash).toLowerCase()); }).catch(() => {});
        return { settled: true, requeued: true, scheduleId: sched.id };
      }
    } else if (sched) {
      recordInclusion(sched.id, row.tx_hash, r, 'reconciled');
    }
    if (sched) db.prepare("UPDATE schedules SET status=? WHERE id=? AND status='submitted'").run(r.status, sched.id);

    let landing = '';
    if (sched) {
      const includedAt = await blockTime(row.chain, r.blockNumber);
      const attempt = db.prepare('SELECT * FROM execution_attempts WHERE schedule_id=? AND lower(tx_hash)=? ORDER BY id DESC LIMIT 1').get(sched.id, String(row.tx_hash).toLowerCase());
      if (includedAt != null && attempt) db.prepare('UPDATE execution_attempts SET included_at=? WHERE id=?').run(includedAt, attempt.id);
      if (r.status === 'confirmed') landing = landingLine(attempt, includedAt);
      if (attempt && includedAt != null) {
        log.info?.('mint landed', { scheduleId: sched.id, txHash: row.tx_hash, status: r.status, mode: attempt.mode, block: r.blockNumber,
          landedAfterSec: landedAfterSec(includedAt, attempt.launch_at), fireDelayMs: attempt.fired_at_ms && attempt.fire_at_ms ? attempt.fired_at_ms - attempt.fire_at_ms : null,
          ackMs: attempt.acked_at_ms && attempt.fired_at_ms ? attempt.acked_at_ms - attempt.fired_at_ms : null, gasUsed: r.gasUsed ?? null });
      }
    }
    const headline = r.status === 'confirmed' ? `🎉 <b>Mint confirmed</b> on ${esc(chain.name)}` : `❌ <b>Transaction failed</b> on ${esc(chain.name)}`;
    const tokens = tokenIds.length ? `\nNFT token ID${tokenIds.length > 1 ? 's' : ''} received: ${tokenIds.slice(0, 20).map(esc).join(', ')}` : '';
    const exhausted = sched && r.status === 'failed' && Number(sched.chain_retries) >= maxChainRetries && maxChainRetries > 0 ? `\nMintPilot already re-signed it ${maxChainRetries} time(s) and stopped.` : '';
    await safeSend(row.telegram_id, `${headline} (block ${r.blockNumber})${tokens}${landing}${exhausted}\n${txUrl(chain, row.tx_hash)}`);
    // Referral reward: the referee's first confirmed MintPilot mint (real, paid on-chain activity).
    if (sched && r.status === 'confirmed') {
      const rewarded = rewardReferral(db, cfg, row.telegram_id, t);
      if (rewarded) {
        await safeSend(rewarded.referrerId, '🎁 A friend you referred completed their first mint — Premium time added to your account.');
        await safeSend(row.telegram_id, '🎁 Referral bonus applied — Premium time added to your account.');
      }
    }
    return { settled: true, requeued: false };
  }

  const engine = createLaunchEngine({
    db, cfg, chains, rpc, fastExecution, withWalletLease, applyOutcome, settleReceipt,
    notifyOnce: (s, kind, text) => notifyOnce(s, kind, text), log, nowMs: clockMs, ...(sleep ? { sleep } : {})
  });

  async function processDue(s, t, lease) {
    let chainTime = t;
    if (typeof rpc.getChainTime === 'function') {
      // Local time only wakes the worker; the chain clock decides whether the mint may start.
      try { chainTime = await rpc.getChainTime(s.chain); }
      catch (e) { log.error('chain time check failed', s.id, e.message); return; }
    }
    if (s.end_at != null && chainTime > Number(s.end_at)) {
      const hasOpen = db.prepare("SELECT 1 FROM execution_attempts WHERE schedule_id=? AND status IN ('submitting','uncertain','submitted')").get(s.id);
      if (!hasOpen && db.prepare("UPDATE schedules SET status='expired', last_error='mint window ended' WHERE id=? AND status IN ('scheduled','ready')").run(s.id).changes) {
        db.prepare("UPDATE execution_attempts SET status='failed', error='mint window ended before it was sent', updated_at=?, resolved_at=? WHERE schedule_id=? AND status='armed'").run(t, t, s.id);
        completeReminder(db, s.id, 'due', t);
        notifyOnce(s, 'expired', `⌛ The mint window for ${label(s)} ended before a mint could be submitted.${s.last_error ? `\nLast status: ${esc(s.last_error)}` : ''}`, t);
        return;
      }
    }
    if (chainTime < launchTarget(s)) return; // not started on-chain yet
    if (!lease.isOwned()) return;
    if (!fastExecution) {
      applyOutcome(s, { outcome: OUTCOME.TERMINAL, userReason: 'Automatic signing is not configured on this deployment.' }, t);
      return;
    }
    let result;
    try { result = await fastExecution.execute(s, { assertLock: lease.isOwned, chainTime, deadline: scheduleDeadline(s, maxWaitSec) }); }
    catch (e) {
      log.error('automatic mint attempt failed unexpectedly', s.id, e.message);
      result = { outcome: OUTCOME.RETRY, userReason: 'Unexpected error; retrying.' };
    }
    applyOutcome(s, result, nowSec());
  }

  /** Premium pre-mint alerts for manual-time schedules. Claimed before sending, so never sent twice. */
  function premiumAlert(s, t, dueAt) {
    if (!(s.premium_until > t) || s.blocked_bot) return;
    const kind = t >= dueAt - 60 ? 'pre1' : (t >= dueAt - 600 ? 'pre10' : null);
    if (!kind || !completeReminder(db, s.id, kind, t)) return;
    const chain = chains[s.chain];
    // Say what the wallet really needs: for OpenSea the saved amount is only a ceiling, and a free mint needs just the network fee.
    let adapter = null;
    try { adapter = JSON.parse(s.mint_spec || 'null')?.adapter; } catch { adapter = null; }
    const where = esc(chain ? chain.name : s.chain);
    const isFree = /^\d+$/.test(String(s.total_wei)) && BigInt(s.total_wei) === 0n;
    const fundsLine = adapter === 'opensea-drop'
      ? `MintPilot signs automatically and reads the exact price from OpenSea at mint time, never above your limit of ${formatWei(s.total_wei)} ETH. Keep enough ETH for the network fee in this wallet on ${where}, plus the mint price if it is not free.`
      : (isFree
        ? `MintPilot signs automatically. This is a free mint, so this wallet only needs ETH for the network fee on ${where}.`
        : `MintPilot signs automatically. Keep at least ${formatWei(s.total_wei)} ETH plus gas in this wallet on ${where}.`);
    notifyLater(s.telegram_id, `🔔 <b>Automatic mint in ~${kind === 'pre1' ? 1 : 10} min</b> (${utc(dueAt)})\n<b>Schedule #${s.id}</b> · ${esc(chain ? chain.name : s.chain)}\nContract: <code>${s.contract}</code>\nWallet: <code>${shortAddr(s.wallet_address)}</code>\n\n${fundsLine}`);
  }

  async function processCandidates(t) {
    const tMs = clockMs();
    const tasks = [];
    for (const candidate of reminderCandidates(db, t, armSec)) {
      if (engine.has(candidate.id)) continue;
      const dueAt = launchTarget(candidate);
      if (candidate.trigger_mode !== 'launch' && t < dueAt) premiumAlert(candidate, t, dueAt);
      if (engine.enabled() && engine.inWindow(candidate, tMs)) {
        if (claimReminder(db, candidate.id, 'due', t)) engine.start(candidate);
        continue;
      }
      if (t < dueAt) continue; // before the opening and outside the engine: nothing to do yet
      tasks.push(runForWallet(candidate.wallet_address, () => withWalletLease(candidate.wallet_address, async (lease) => {
        const s = getSchedule(db, candidate.id) || candidate; // re-read: another task may have changed it
        if (!['scheduled', 'ready'].includes(s.status)) return;
        if (!claimReminder(db, s.id, 'due', t)) return; // already submitted, failed or dry-run completed
        await processDue(s, t, lease);
      })).catch((e) => log.error('schedule processing failed', candidate.id, e.message)));
    }
    await Promise.all(tasks);
  }

  function expireSchedules(t) {
    for (const s of expireStale(db, t, maxWaitSec)) {
      completeReminder(db, s.id, 'due', t);
      notifyOnce(s, 'expired', `⌛ ${label(s)} expired: no mint could be submitted before ${utc(scheduleDeadline(s, maxWaitSec))}.${s.last_error ? `\nLast status: ${esc(s.last_error)}` : ''}`, t);
    }
  }

  /** Receipt polling: bounded parallelism, lowest RPC priority (never delays a launch or a user command). */
  async function pollTransactions(t) {
    const rows = pendingTxs(db).filter((row) => !engine.isWatching(row.tx_hash)); // sessions poll their own
    let next = 0;
    const lanes = Array.from({ length: Math.min(trackingConcurrency, rows.length) }, async () => {
      while (next < rows.length) await pollOne(rows[next++], t);
    });
    await withRpcPriority('low', () => Promise.all(lanes));
  }

  async function pollOne(row, t) {
    {
      try {
        const chain = chains[row.chain];
        if (!chain) return;
        const r = await rpc.getReceipt(row.chain, row.tx_hash);
        if (!r) {
          if (t - row.created_at > DROP_AFTER_SEC && finishTx(db, row.id, { status: 'dropped' })) {
            if (row.schedule_id) db.prepare("UPDATE schedules SET status='failed', last_error='transaction dropped' WHERE id=? AND status='submitted'").run(row.schedule_id);
            if (row.schedule_id) db.prepare("UPDATE execution_attempts SET status='failed', error=?, updated_at=?, resolved_at=? WHERE schedule_id=? AND status IN ('submitting','uncertain','submitted')")
              .run('tracked transaction was dropped', t, t, row.schedule_id);
            await safeSend(row.telegram_id, `⚠️ Transaction not found on ${esc(chain.name)} after 24h — it was probably dropped or replaced.\n${txUrl(chain, row.tx_hash)}`);
          }
          return;
        }
        if (r.confirmations < chain.confirmations) return;
        await settleReceipt(row, r, t);
      } catch (e) {
        log.error('track failed', row.id, e.message);
      }
    }
  }

  async function tick() {
    const t = nowSec();
    await processCandidates(t);
    expireSchedules(nowSec());
    await pollTransactions(t);
  }

  let timer = null;
  let running = null;      // promise of the tick in progress
  let lastTickAt = null;   // ms, end of the last completed tick
  let lastTickMs = null;
  return {
    tick,
    settleReceipt,
    engine,
    /** Resolves when every launch session has finished (tests and graceful shutdown). */
    idle: () => engine.idle(),
    start(intervalMs = cfg.workerTickMs ?? 5000) {
      const loop = () => {
        if (running) return running;
        const began = Date.now();
        running = (async () => {
          try { await tick(); } catch (e) { log.error('worker tick', e); } finally {
            lastTickAt = Date.now(); lastTickMs = lastTickAt - began; running = null;
          }
        })();
        return running;
      };
      loop();
      timer = setInterval(loop, intervalMs);
    },
    stop() { if (timer) clearInterval(timer); timer = null; engine.stop(); },
    /** Stop new work, then wait (bounded) for the current tick and every launch session to end. */
    async drain(timeoutMs = 20_000) {
      this.stop();
      const done = Promise.all([running || Promise.resolve(), engine.idle()]);
      let timedOut = false;
      const wait = new Promise((resolve) => { const t = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); if (t.unref) t.unref(); });
      await Promise.race([done, wait]);
      if (timedOut) log.warn?.('worker drain timed out; armed attempts stay persisted and resume on restart');
    },
    stats: () => ({ lastTickAt, lastTickMs, tickRunning: Boolean(running), launchSessions: engine.sessions() })
  };
}

module.exports = { createWorker, createWalletExecutionQueue };
