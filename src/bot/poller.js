'use strict';
// Telegram long polling with a durable inbox and concurrent, per-chat-ordered dispatch.
//
//   poll ──► INSERT updates into tg_inbox + advance offset (one transaction) ──► dispatch
//   dispatch: one FIFO queue per chat (a chat's updates are handled strictly in order, never two at
//             once), up to BOT_MAX_CONCURRENT_UPDATES chats in parallel. Payment pre-checkout queries
//             skip the queues: Telegram cancels the payment if they are not answered within 10 s.
//   done:     DELETE FROM tg_inbox. On restart, rows still in the inbox are replayed (at-least-once);
//             a row that was attempted 3 times, or is older than 10 minutes, is dropped and logged.
//
// Run exactly ONE polling instance per bot token. A second instance (or a webhook) makes Telegram
// answer 409 Conflict; the poller logs it loudly and backs off instead of spinning.
const REPLAY_MAX_AGE_SEC = 600;
const MAX_ATTEMPTS = 3;
const SLOW_UPDATE_MS = 30_000;

function chatKeyOf(u) {
  const chat = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? u.callback_query?.from?.id ?? u.pre_checkout_query?.from?.id;
  return chat == null ? `update:${u.update_id}` : String(chat);
}
const kindOf = (u) => (u.pre_checkout_query ? 'pre_checkout' : u.callback_query ? 'callback' : u.message ? 'message' : 'other');

function createPoller({
  tg, db, handler, log = console, onError = null,
  maxConcurrent = 32,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Math.floor(Date.now() / 1000), nowMs = () => Date.now()
}) {
  let stopped = false;
  let abort = null;
  let lastPollOkAt = null;
  let lastConflictAt = null;
  const queues = new Map(); // chatKey -> [update]
  const running = new Set(); // chatKeys with an update in progress
  const ready = [];          // chatKeys waiting for a concurrency slot (FIFO, fair)
  let active = 0;
  const idleWaiters = [];

  const getOffset = () => { const r = db.prepare("SELECT value FROM kv WHERE key='tg_offset'").get(); return r ? Number(r.value) : 0; };
  const insert = db.prepare('INSERT OR IGNORE INTO tg_inbox (update_id, chat_key, kind, payload, received_at) VALUES (?,?,?,?,?)');
  const setOffset = db.prepare("INSERT INTO kv (key,value) VALUES ('tg_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const remove = db.prepare('DELETE FROM tg_inbox WHERE update_id=?');
  const bump = db.prepare('UPDATE tg_inbox SET attempts = attempts + 1 WHERE update_id=?');

  /** Persist a batch and advance the offset atomically: an update is either stored or will be re-fetched. */
  function store(updates) {
    if (!updates.length) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      const t = now();
      for (const u of updates) insert.run(u.update_id, chatKeyOf(u), kindOf(u), JSON.stringify(u), t);
      setOffset.run(String(Math.max(...updates.map((u) => u.update_id)) + 1));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  async function handleOne(u) {
    const started = nowMs();
    const slow = setTimeout(() => log.warn?.('slow update', { updateId: u.update_id, kind: kindOf(u), ms: nowMs() - started }), SLOW_UPDATE_MS);
    if (typeof slow.unref === 'function') slow.unref();
    try {
      bump.run(u.update_id);
      await handler.handleUpdate(u);
    } catch (e) {
      log.error('update failed', { updateId: u.update_id, kind: kindOf(u), error: e?.message });
      if (onError) await Promise.resolve(onError(u, e)).catch(() => {});
    } finally {
      clearTimeout(slow);
      remove.run(u.update_id);
    }
  }

  function settleIdle() {
    if (active === 0 && !ready.length && ![...queues.values()].some((q) => q.length)) idleWaiters.splice(0).forEach((r) => r());
  }

  function pumpQueues() {
    while (active < maxConcurrent && ready.length) {
      const key = ready.shift();
      const q = queues.get(key);
      if (!q || !q.length) { queues.delete(key); continue; }
      const u = q.shift();
      active += 1;
      running.add(key);
      handleOne(u).finally(() => {
        active -= 1;
        running.delete(key);
        if (q.length) ready.push(key); else queues.delete(key);
        pumpQueues();
        settleIdle();
      });
    }
    settleIdle();
  }

  function dispatch(u) {
    if (u.pre_checkout_query) { // must be answered within 10 s: never queued behind anything
      active += 1;
      handleOne(u).finally(() => { active -= 1; settleIdle(); });
      return;
    }
    const key = chatKeyOf(u);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(u);
    if (!running.has(key) && !ready.includes(key)) ready.push(key);
    pumpQueues();
  }

  /** Replay what a previous process stored but did not finish. */
  function replay() {
    const rows = db.prepare('SELECT update_id, kind, payload, received_at, attempts FROM tg_inbox ORDER BY update_id').all();
    const cutoff = now() - REPLAY_MAX_AGE_SEC;
    let replayed = 0;
    for (const row of rows) {
      if (row.attempts >= MAX_ATTEMPTS || row.received_at < cutoff || row.kind === 'pre_checkout') {
        log.warn?.('dropping stale inbox update', { updateId: row.update_id, kind: row.kind, attempts: row.attempts });
        remove.run(row.update_id);
        continue;
      }
      try { dispatch(JSON.parse(row.payload)); replayed += 1; } catch { remove.run(row.update_id); }
    }
    if (replayed) log.info?.('replaying unfinished updates', { count: replayed });
  }

  async function run() {
    await tg.deleteWebhook().catch(() => {});
    replay();
    while (!stopped) {
      abort = new AbortController();
      try {
        const updates = await tg.getUpdates({ offset: getOffset(), timeout: 50, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'] }, { signal: abort.signal });
        lastPollOkAt = now();
        store(updates);
        for (const u of updates) dispatch(u);
      } catch (e) {
        if (stopped) break;
        if (e?.conflict || e?.code === 409) {
          lastConflictAt = now();
          log.error('Telegram 409 Conflict: another process is polling this bot token (or a webhook is set). Run exactly one bot instance per token.');
          await sleep(10_000);
        } else {
          log.error('polling error', e?.message);
          await sleep(3000);
        }
      }
    }
  }

  return {
    run,
    /** Stop polling (aborts the open long poll). In-flight updates keep running; see drain(). */
    stop() { stopped = true; if (abort) abort.abort(); },
    /** Resolves when every dispatched update has finished, or after `timeoutMs`. */
    drain(timeoutMs = 20_000) {
      return Promise.race([
        new Promise((resolve) => { idleWaiters.push(resolve); settleIdle(); }),
        new Promise((resolve) => { const t = setTimeout(resolve, timeoutMs); if (t.unref) t.unref(); })
          .then(() => { if (active) log.warn?.('shutdown drain timed out; unfinished updates stay in the inbox and replay on restart', { active }); })
      ]);
    },
    stats() {
      return { active, queuedChats: queues.size, queued: [...queues.values()].reduce((n, q) => n + q.length, 0), lastPollOkAt, lastConflictAt };
    }
  };
}
module.exports = { createPoller, chatKeyOf };
