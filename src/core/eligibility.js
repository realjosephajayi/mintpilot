'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeAddress } = require('./wallets');

function parseAddressFile(contents, filePath) {
  const source = String(contents || '').trim();
  if (!source) return [];

  let values;
  if (source.startsWith('[') || source.startsWith('{')) {
    try {
      const parsed = JSON.parse(source);
      values = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.addresses) ? parsed.addresses : null;
    } catch (error) {
      throw new Error(`Eligibility file ${filePath} contains invalid JSON.`);
    }
    if (!values) throw new Error(`Eligibility file ${filePath} must be an address array or an object with an addresses array.`);
  } else {
    values = source.split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim()).filter(Boolean);
  }

  const addresses = new Set();
  for (const value of values) {
    try {
      addresses.add(normalizeAddress(value));
    } catch {
      throw new Error(`Eligibility file ${filePath} contains an invalid EVM address: ${value}`);
    }
  }
  return [...addresses];
}

function loadEligibilityFile(filePath = 'data/eligible-addresses.json') {
  const resolved = path.resolve(filePath);
  try {
    return new Set(parseAddressFile(fs.readFileSync(resolved, 'utf8'), resolved));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
}

function checkEligibility(address, filePath) {
  const normalized = normalizeAddress(address);
  const addresses = loadEligibilityFile(filePath);
  return { address: normalized, listed: addresses.has(normalized), filePath: path.resolve(filePath) };
}

module.exports = { parseAddressFile, loadEligibilityFile, checkEligibility };
