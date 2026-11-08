'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkMintReadiness } = require('../../src/core/readiness');
const { A, makeCfg } = require('./helpers');

test('mint readiness checks selected wallet, funding, ownership, history, and preflight', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mintpilot-ready-')), 'eligible.json');
  fs.writeFileSync(file, JSON.stringify([A(1)]));
  const cfg = makeCfg(); cfg.eligibilityFile = file;
  const schedule = { id: 7, wallet_address: A(1), chain: 'base', contract: A(5), total_wei: '100', quantity: 1 };
  const result = await checkMintReadiness({
    schedule, cfg, chains: { base: { key: 'base' } },
    rpc: {
      hasCode: async () => true,
      getBalance: async () => '1000',
      getErc721Balance: async () => '0',
      simulate: async () => ({ ok: true })
    },
    buildMintTx: () => ({ from: A(1), to: A(5), data: '0x', value: '0x0' }),
    db: { prepare: () => ({ get: () => null }) }
  });
  assert.equal(result.listedInEligibilityFile, true);
  assert.equal(result.contractExists, true);
  assert.equal(result.nativeBalanceWei, '1000');
  assert.equal(result.nftBalance, '0');
  assert.equal(result.ready, true);
});

test('eligibility-file absence does not claim a definitive on-chain rejection', async () => {
  const cfg = makeCfg(); cfg.eligibilityFile = '/tmp/mintpilot-missing-eligibility-file.json';
  const result = await checkMintReadiness({
    schedule: { id: 8, wallet_address: A(1), chain: 'base', contract: A(5), total_wei: '100', quantity: 1 },
    cfg, chains: { base: { key: 'base' } },
    rpc: { hasCode: async () => true, getBalance: async () => '1000', getErc721Balance: async () => '0', simulate: async () => ({ ok: true }) },
    buildMintTx: () => ({ from: A(1), to: A(5), data: '0x', value: '0x0' })
  });
  assert.equal(result.listedInEligibilityFile, false);
  assert.equal(result.ready, true);
  assert.ok(result.checks.find((c) => c.name === 'allowlist-file').advisory);
});
