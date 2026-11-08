'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAddressFile, loadEligibilityFile, checkEligibility } = require('../../src/core/eligibility');

const A = (n) => '0x' + String(n).padStart(40, '0');

test('eligibility reader accepts JSON and collapses duplicate addresses', () => {
  const values = parseAddressFile(JSON.stringify({ addresses: [A(1), A(1)] }), 'test.json');
  assert.deepEqual(values, [A(1)]);
});

test('eligibility reader accepts one address per line and comments', () => {
  const values = parseAddressFile(`# comment\n${A(2)}\n${A(3)} # note\n`, 'test.txt');
  assert.deepEqual(values, [A(2), A(3)]);
});

test('checkEligibility reports listed and unlisted addresses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintpilot-eligibility-'));
  const file = path.join(dir, 'addresses.json');
  fs.writeFileSync(file, JSON.stringify([A(7)]));
  assert.equal(checkEligibility(A(7), file).listed, true);
  assert.equal(checkEligibility(A(8), file).listed, false);
  assert.equal(loadEligibilityFile(path.join(dir, 'missing.json')).size, 0);
});
