'use strict';
// Minimal Telegram Bot API client (fetch-based, zero dependencies) with outbound pacing.
//
// Pacing (enabled when `pacing` is given; src/index.js always gives it):
//   * global token bucket below Telegram's ~30 messages/s bot limit;
//   * per-chat bucket (small burst, then ~1 message/s), one message in flight per chat so a chat's
//     messages arrive in order;
//   * chats are served round-robin, so a fan-out to thousands of users after a big launch cannot starve
//     a user who is talking to the bot right now;
//   * a 429 pauses ALL paced sends for retry_after and re-queues the message (up to 3 times).
// Time-critical calls (answerCallbackQuery, answerPreCheckoutQuery, getUpdates) are never queued.
class TelegramError extends Error {
  constructor(method, code, description, params) {
    super(`${method}: ${code} ${description}`);
    this.method = method; this.code = code; this.description = description; this.retryAfter = params && params.retry_after;
  }
  get blocked() { return this.code === 403; }
  /** Another getUpdates consumer (second instance) or a webhook is active for this token. */
  get conflict() { return this.code === 409; }
}

function createPacer({ globalPerSecond = 25, perChatIntervalMs = 1000, perChatBurst = 3, now = Date.now, sleep }) {
  const chats = new Map(); // chatKey -> { queue: [], tokens, last, busy }
  const order = [];        // round-robin of chat keys with queued work
  let globalTokens = globalPerSecond;
  let globalLast = now();
  let pausedUntil = 0;
  let pumping = false;
  let wake = null;

  const refillGlobal = (t) => { globalTokens = Math.min(globalPerSecond, globalTokens + ((t - globalLast) * globalPerSecond) / 1000); globalLast = t; };
  const refillChat = (c, t) => {
    if (perChatIntervalMs <= 0) { c.tokens = perChatBurst; return; }
    c.tokens = Math.min(perChatBurst, c.tokens + (t - c.last) / perChatIntervalMs); c.last = t;
  };
  const chatState = (key) => {
    let c = chats.get(key);
    if (!c) { c = { queue: [], tokens: perChatBurst, last: now(), busy: false }; chats.set(key, c); }
    return c;
  };

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (order.length) {
        const t = now();
        if (t < pausedUntil) { await sleep(pausedUntil - t); continue; }
        refillGlobal(t);
        let started = false;
        let soonest = Infinity;
        for (let i = 0; i < order.length && globalTokens >= 1; i += 1) {
          const key = order[i];
          const c = chats.get(key);
          if (c.busy) continue;
          refillChat(c, t);
          if (c.tokens < 1) { soonest = Math.min(soonest, (1 - c.tokens) * perChatIntervalMs); continue; }
          c.tokens -= 1; globalTokens -= 1; c.busy = true; started = true;
          const job = c.queue.shift();
          order.splice(i, 1); i -= 1;
          run(key, c, job);
        }
        if (started) continue;
        const globalWait = globalTokens >= 1 ? Infinity : ((1 - globalTokens) * 1000) / globalPerSecond;
        const wait = Math.min(soonest, globalWait);
        if (!Number.isFinite(wait)) {
          // Every queued chat has a message in flight: wait for one to finish.
          await new Promise((resolve) => { wake = resolve; });
          wake = null;
        } else {
          await sleep(Math.max(1, Math.ceil(wait)));
        }
      }
    } finally { pumping = false; }
  }

  function requeue(key, c) {
    c.busy = false;
    if (c.queue.length && !order.includes(key)) order.push(key);
    if (wake) wake();
    pump();
  }

  // Idle chat state is kept until its bucket is full again (so back-to-back awaited sends are still
  // paced), then swept.
  function sweep(t) {
    const full = perChatIntervalMs * perChatBurst;
    for (const [key, c] of chats) if (!c.busy && !c.queue.length && t - c.last >= full) chats.delete(key);
  }

  async function run(key, c, job) {
    try {
      job.resolve(await job.fn());
    } catch (e) {
      if (e instanceof TelegramError && e.code === 429 && job.attempts < 3) {
        job.attempts += 1;
        pausedUntil = Math.max(pausedUntil, now() + (Number(e.retryAfter) || 1) * 1000);
        c.queue.unshift(job);
      } else job.reject(e);
    } finally { requeue(key, c); }
  }

  return {
    schedule(chatId, fn) {
      return new Promise((resolve, reject) => {
        const key = String(chatId);
        if (chats.size > 1000) sweep(now());
        const c = chatState(key);
        c.queue.push({ fn, resolve, reject, attempts: 0 });
        if (!c.busy && !order.includes(key)) order.push(key);
        if (wake) wake();
        pump();
      });
    },
    stats: () => ({ chats: chats.size, queued: [...chats.values()].reduce((n, c) => n + c.queue.length, 0), pausedUntil })
  };
}

function createTelegram({ token, fetchImpl = fetch, baseUrl = 'https://api.telegram.org', sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pacing = null, now = Date.now }) {
  async function call(method, params = {}, { timeoutMs = 20000, retry = true, networkAttempts = 3, signal = null } = {}) {
    let res;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      res = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (retry && networkAttempts > 1) {
        await sleep(1000 * (4 - networkAttempts));
        return call(method, params, { timeoutMs, retry, networkAttempts: networkAttempts - 1, signal });
      }
      throw e;
    }
    const body = await res.json().catch(() => ({}));
    if (body.ok) return body.result;
    const err = new TelegramError(method, body.error_code || res.status, body.description || 'unknown error', body.parameters);
    if (err.code === 429 && retry && err.retryAfter && err.retryAfter <= 30) {
      await sleep(err.retryAfter * 1000);
      return call(method, params, { timeoutMs, retry: false, networkAttempts: 1, signal });
    }
    throw err;
  }

  const pacer = pacing ? createPacer({ ...pacing, now, sleep }) : null;
  // Paced sends leave 429 handling to the pacer (it pauses every chat, not just this request).
  const paced = (chatId, method, params) => (pacer
    ? pacer.schedule(chatId, () => call(method, params, { retry: false }))
    : call(method, params));

  return {
    call,
    pacer,
    getMe: () => call('getMe'),
    getUpdates: (p, { signal } = {}) => call('getUpdates', p, { timeoutMs: (p.timeout || 0) * 1000 + 10000, signal }),
    deleteWebhook: () => call('deleteWebhook', { drop_pending_updates: false }),
    setMyCommands: (commands) => call('setMyCommands', { commands }),
    sendMessage: (chat_id, text, extra = {}) => paced(chat_id, 'sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
    editMessageText: (chat_id, message_id, text, extra = {}) => paced(chat_id, 'editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
    deleteMessage: (chat_id, message_id) => call('deleteMessage', { chat_id, message_id }),
    answerCallbackQuery: (id, text) => call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }),
    sendInvoice: (chat_id, inv) => paced(chat_id, 'sendInvoice', { chat_id, title: inv.title, description: inv.description, payload: inv.payload, currency: inv.currency, prices: inv.prices, provider_token: '' }),
    answerPreCheckoutQuery: (id, ok, error_message) => call('answerPreCheckoutQuery', { pre_checkout_query_id: id, ok, ...(ok ? {} : { error_message }) })
  };
}
module.exports = { createTelegram, createPacer, TelegramError };
