'use strict';
// "Minted out" detection: a collection whose totalSupply has reached its maxSupply has nothing left to mint.
const { Interface } = require('ethers');

const SUPPLY = new Interface(['function totalSupply() view returns (uint256)', 'function maxSupply() view returns (uint256)']);
const word = (v) => (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null);

/** True when both numbers are known, a cap exists, and the minted count has reached it. */
function isMintedOut(minted, max) {
  if (!/^\d+$/.test(String(minted ?? '')) || !/^\d+$/.test(String(max ?? ''))) return false;
  return BigInt(max) > 0n && BigInt(minted) >= BigInt(max);
}

/** Reads totalSupply and maxSupply with two cheap eth_calls. Returns { minted, max } when fully minted, otherwise null (also null when unreadable). */
async function readMintedOut(rpc, chain, address) {
  if (!rpc || typeof rpc.ethCall !== 'function') return null;
  try {
    const calls = ['totalSupply', 'maxSupply'].map((fn) => Promise.resolve(rpc.ethCall(chain, address, SUPPLY.encodeFunctionData(fn))).catch(() => null));
    const [minted, max] = (await Promise.all(calls)).map(word);
    if (minted == null || max == null || !isMintedOut(minted, max)) return null;
    return { minted: minted.toString(), max: max.toString() };
  } catch { return null; }
}

const mintedOutText = (name, minted, max) => `❌ <b>${name} is minted out</b> (${minted} / ${max}).\nThere is nothing left to mint, so I did not schedule it. Send a different collection or contract, or tap Cancel.`;

module.exports = { isMintedOut, readMintedOut, mintedOutText };
