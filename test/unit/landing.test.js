'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderLanding } = require('../../src/web/landing');

const template = fs.readFileSync(path.join(__dirname, '../../src/web/public/index.html'), 'utf8');
const cfg = {
  publicUrl: 'https://mintpilot.example',
  automation: { allowedChains: ['base', 'ink', 'nope'] },
  plans: { free: { activeSchedules: 3, wallets: 1 }, premium: { activeSchedules: 30, wallets: 5, pendingTxs: 50 } },
  premium: { priceStars: 500, days: 30 }
};
const chains = { base: { name: 'Base' }, ink: { name: 'Ink' }, zora: { name: 'Zora' } };

test('the front page shows the configured plans, only the allowed networks and the Telegram link', () => {
  const html = renderLanding(template, { cfg, chains, botUsername: 'Mint_pilotBot', year: 2030 });
  assert.doesNotMatch(html, /__[A-Z_]{3,}__/);
  assert.match(html, /href="https:\/\/t\.me\/Mint_pilotBot"/);
  assert.match(html, /<li>Base<\/li><li>Ink<\/li>/);
  assert.doesNotMatch(html, /Zora|nope/);
  assert.match(html, /Mint on 2 networks/);
  assert.match(html, /500 Stars/);
  assert.match(html, /for 30 days/);
  assert.match(html, /1 wallet</);
  assert.match(html, /5 wallets</);
  assert.match(html, /3 active scheduled mints at a time/);
  assert.match(html, /href="https:\/\/mintpilot\.example\/"/);
  assert.match(html, /© 2030 MintPilot/);
});

test('without a known bot username the buttons scroll to the explanation instead of pointing nowhere', () => {
  const html = renderLanding(template, { cfg, chains, botUsername: '' });
  assert.doesNotMatch(html, /href="#"/);
  assert.match(html, /class="btn" href="#how"/);
});

test('network names and the public address are escaped', () => {
  const html = renderLanding(template, { cfg: { ...cfg, automation: { allowedChains: ['x'] } }, chains: { x: { name: '<script>alert(1)</script>' } }, botUsername: 'abcd' });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});
