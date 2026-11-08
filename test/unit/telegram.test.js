'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegram, TelegramError } = require('../../src/telegram');

const resp = (body, status = 200) => ({ status, json: async () => body });

test('sends JSON to the right endpoint and returns result', async () => {
  let seen;
  const tg = createTelegram({ token: 'T', fetchImpl: async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return resp({ ok: true, result: { id: 1 } }); } });
  assert.deepEqual(await tg.sendMessage(5, 'hi'), { id: 1 });
  assert.equal(seen.url, 'https://api.telegram.org/botT/sendMessage');
  assert.equal(seen.body.parse_mode, 'HTML');
  assert.equal(seen.body.chat_id, 5);
});

test('retries once on 429 using retry_after, then succeeds', async () => {
  let n = 0; const slept = [];
  const tg = createTelegram({ token: 'T', sleep: async (ms) => slept.push(ms), fetchImpl: async () => (++n === 1 ? resp({ ok: false, error_code: 429, description: 'Too Many', parameters: { retry_after: 2 } }, 429) : resp({ ok: true, result: true })) });
  assert.equal(await tg.sendMessage(1, 'x'), true);
  assert.deepEqual(slept, [2000]);
});

test('403 is surfaced as a blocked error', async () => {
  const tg = createTelegram({ token: 'T', fetchImpl: async () => resp({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 403) });
  await assert.rejects(() => tg.sendMessage(1, 'x'), (e) => e instanceof TelegramError && e.blocked);
});

test('invoices for Stars use empty provider token and XTR', async () => {
  let body;
  const tg = createTelegram({ token: 'T', fetchImpl: async (u, o) => { body = JSON.parse(o.body); return resp({ ok: true, result: {} }); } });
  await tg.sendInvoice(1, { title: 't', description: 'd', payload: 'p', currency: 'XTR', prices: [{ label: 'x', amount: 250 }] });
  assert.equal(body.provider_token, ''); assert.equal(body.currency, 'XTR');
});
