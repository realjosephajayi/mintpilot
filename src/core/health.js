'use strict';
// Liveness, readiness and Prometheus metrics for operating MintPilot at scale.
//   GET /healthz  — process is up (no checks; for restart decisions).
//   GET /readyz   — database answers, the Telegram poller and worker tick are recent, the event loop is
//                   responsive. 503 with the failing checks otherwise.
//   GET /metrics  — Prometheus text format; requires METRICS_TOKEN (Authorization: Bearer <token>).
// Nothing here exposes user data, wallet addresses, RPC URLs or secrets.
const { monitorEventLoopDelay } = require('node:perf_hooks');

function createHealth({ db, cfg, chains = {}, rpc = null, poller = null, worker = null, tg = null, roles = new Set(), nowMs = () => Date.now() }) {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const startedAt = nowMs();
  const tickBudgetMs = Math.max(30_000, (cfg.workerTickMs || 5000) * 6);

  function checks() {
    const out = [];
    try { db.prepare('SELECT 1').get(); out.push({ name: 'database', ok: true }); }
    catch (e) { out.push({ name: 'database', ok: false, detail: e.message }); }
    if (roles.has('bot') && poller) {
      const s = poller.stats();
      const age = s.lastPollOkAt == null ? null : nowMs() / 1000 - s.lastPollOkAt;
      // A long poll lasts up to ~60 s; allow two missed polls after the first minute of uptime.
      const ok = (age != null && age < 130) || (s.lastPollOkAt == null && nowMs() - startedAt < 90_000);
      out.push({ name: 'telegram-poll', ok, detail: age == null ? 'no successful poll yet' : `last ok ${Math.round(age)}s ago` });
    }
    if (roles.has('worker') && worker) {
      const s = worker.stats();
      const age = s.lastTickAt == null ? null : nowMs() - s.lastTickAt;
      const ok = (age != null && age < tickBudgetMs) || (s.lastTickAt == null && nowMs() - startedAt < tickBudgetMs) || s.tickRunning;
      out.push({ name: 'worker-tick', ok, detail: age == null ? 'no completed tick yet' : `last tick ${Math.round(age / 1000)}s ago` });
    }
    const p99 = loop.percentile(99) / 1e6;
    out.push({ name: 'event-loop', ok: p99 < 1000, detail: `p99 delay ${p99.toFixed(1)} ms` });
    return out;
  }

  function readiness() {
    const list = checks();
    return { ok: list.every((c) => c.ok), checks: list };
  }

  function metrics() {
    const lines = [];
    const gauge = (name, help, samples) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const [labels, value] of samples) {
        const l = Object.entries(labels || {}).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`).join(',');
        lines.push(`${name}${l ? `{${l}}` : ''} ${Number.isFinite(Number(value)) ? Number(value) : 0}`);
      }
    };
    gauge('mintpilot_up', 'Process is running.', [[{}, 1]]);
    gauge('mintpilot_uptime_seconds', 'Seconds since start.', [[{}, Math.round((nowMs() - startedAt) / 1000)]]);
    gauge('mintpilot_event_loop_delay_ms', 'Event loop delay percentiles.', [[{ quantile: '0.5' }, loop.percentile(50) / 1e6], [{ quantile: '0.99' }, loop.percentile(99) / 1e6], [{ quantile: 'max' }, loop.max / 1e6]]);
    if (poller) {
      const s = poller.stats();
      gauge('mintpilot_updates_active', 'Telegram updates being handled now.', [[{}, s.active]]);
      gauge('mintpilot_updates_queued', 'Telegram updates waiting for their chat or a slot.', [[{}, s.queued]]);
      gauge('mintpilot_inbox_rows', 'Durable inbox rows (stored, not yet finished).', [[{}, db.prepare('SELECT COUNT(*) n FROM tg_inbox').get().n]]);
    }
    if (tg && tg.pacer) gauge('mintpilot_telegram_outbound_queued', 'Outbound Telegram messages waiting for pacing.', [[{}, tg.pacer.stats().queued]]);
    if (worker) {
      const s = worker.stats();
      gauge('mintpilot_launch_sessions', 'Active launch-engine sessions.', [[{}, s.launchSessions]]);
      gauge('mintpilot_worker_last_tick_age_seconds', 'Seconds since the last completed worker tick.', [[{}, s.lastTickAt == null ? -1 : (nowMs() - s.lastTickAt) / 1000]]);
      gauge('mintpilot_worker_last_tick_duration_ms', 'Duration of the last worker tick.', [[{}, s.lastTickMs ?? -1]]);
    }
    gauge('mintpilot_schedules', 'Schedules by status.', db.prepare('SELECT status, COUNT(*) n FROM schedules GROUP BY status').all().map((r) => [{ status: r.status }, r.n]));
    gauge('mintpilot_execution_attempts_open', 'Execution attempts not yet resolved, by status (uncertain needs attention).',
      db.prepare("SELECT status, COUNT(*) n FROM execution_attempts WHERE status IN ('armed','submitting','uncertain','submitted') GROUP BY status").all().map((r) => [{ status: r.status }, r.n]));
    gauge('mintpilot_tracked_txs_pending', 'Transactions waiting for a receipt.', [[{}, db.prepare("SELECT COUNT(*) n FROM tracked_txs WHERE status='pending'").get().n]]);
    if (rpc) {
      const samples = [];
      const queued = [];
      for (const key of Object.keys(chains)) {
        let health = [];
        try { health = rpc.health(key); } catch { continue; }
        for (const e of health) {
          const up = !e.disabled && !(e.cooldownUntil > nowMs());
          samples.push([{ chain: key, endpoint: e.endpoint }, up ? 1 : 0]);
          if (e.queued) queued.push([{ chain: key, endpoint: e.endpoint, priority: 'high' }, e.queued.high], [{ chain: key, endpoint: e.endpoint, priority: 'normal' }, e.queued.normal], [{ chain: key, endpoint: e.endpoint, priority: 'low' }, e.queued.low]);
        }
      }
      gauge('mintpilot_rpc_endpoint_up', 'RPC endpoint usable (not quarantined or cooling down).', samples);
      gauge('mintpilot_rpc_queued_requests', 'RPC reads waiting for the endpoint rate limiter.', queued);
    }
    return `${lines.join('\n')}\n`;
  }

  return { readiness, metrics, stop: () => loop.disable() };
}

module.exports = { createHealth };
