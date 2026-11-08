'use strict';
// thirdweb Drop adapter (DropERC721 / DropERC1155 and the single-phase variants).
//
// Source of truth: @thirdweb-dev/contracts 3.15.0 — extension/Drop.sol, extension/Drop1155.sol,
// prebuilts/drop/DropERC721.sol, prebuilts/drop/DropERC1155.sol and the published ABI JSON.
//   claim(address receiver, uint256 quantity, address currency, uint256 pricePerToken,
//         (bytes32[] proof, uint256 quantityLimitPerWallet, uint256 pricePerToken, address currency) allowlistProof,
//         bytes data)                                                                      selector 0x84bb1e42
//   claim(address receiver, uint256 tokenId, uint256 quantity, ...same...)                 selector 0x57bc3d78
//   verifyClaim requires currency == condition.currency AND pricePerToken == condition.pricePerToken exactly
//   (DropClaimInvalidTokenPrice otherwise); native payment requires msg.value == quantity × price exactly
//   ("!V"); the platform fee is taken out of that amount, never added on top.
//
// Scope (fail closed outside it):
//   * public phases only (merkleRoot == 0). Allowlist phases need a per-wallet proof provider.
//   * native-coin price only. ERC-20 priced phases need the approval workflow (docs/HANDOFF.md).
//   * receiver is always the scheduled wallet; tokenId is bound for ERC-1155.
// Deployments are per-creator proxies, so the adapter works on every chain in the registry.

const { Interface, AbiCoder, getAddress, isAddress, ZeroAddress, MaxUint256, ZeroHash, dataLength } = require('ethers');
const { MintSpecError } = require('../errors');

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const PROOF_TUPLE = '(bytes32[] proof,uint256 quantityLimitPerWallet,uint256 pricePerToken,address currency)';
const CONDITION_TUPLE = '(uint256 startTimestamp,uint256 maxClaimableSupply,uint256 supplyClaimed,uint256 quantityLimitPerWallet,bytes32 merkleRoot,uint256 pricePerToken,address currency,string metadata)';

const CLAIM_721 = new Interface([`function claim(address receiver,uint256 quantity,address currency,uint256 pricePerToken,${PROOF_TUPLE} allowlistProof,bytes data) payable`]);
const CLAIM_1155 = new Interface([`function claim(address receiver,uint256 tokenId,uint256 quantity,address currency,uint256 pricePerToken,${PROOF_TUPLE} allowlistProof,bytes data) payable`]);
const READ_721 = new Interface([
  'function claimCondition() view returns (uint256 currentStartId, uint256 count)',
  `function getClaimConditionById(uint256 conditionId) view returns (${CONDITION_TUPLE} condition)`
]);
const READ_1155 = new Interface([
  'function claimCondition(uint256 tokenId) view returns (uint256 currentStartId, uint256 count)',
  `function getClaimConditionById(uint256 tokenId,uint256 conditionId) view returns (${CONDITION_TUPLE} condition)`
]);
const ERRORS = new Interface([
  'error DropClaimNotStarted(uint256 expected, uint256 actual)',
  'error DropNoActiveCondition()',
  'error DropClaimExceedLimit(uint256 expected, uint256 actual)',
  'error DropClaimExceedMaxSupply(uint256 expected, uint256 actual)',
  'error DropClaimInvalidTokenPrice(address expectedCurrency, uint256 expectedPricePerToken, address actualCurrency, uint256 actualExpectedPricePerToken)',
  'error DropExceedMaxSupply()'
]);
const coder = AbiCoder.defaultAbiCoder();
const MAX_PHASES = 25;

const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const isNative = (currency) => sameAddress(currency, NATIVE) || sameAddress(currency, ZeroAddress);

function uint(value, label) {
  try { const n = BigInt(value); if (n < 0n) throw new Error(); return n; } catch { throw new MintSpecError(`${label} must be a non-negative integer.`); }
}

/** Normalized phase, JSON-safe (decimal strings). */
function phase(id, c) {
  return {
    id: Number(id),
    startTimestamp: Number(c.startTimestamp),
    maxClaimableSupply: c.maxClaimableSupply.toString(),
    supplyClaimed: c.supplyClaimed.toString(),
    quantityLimitPerWallet: c.quantityLimitPerWallet.toString(),
    allowlist: c.merkleRoot !== ZeroHash,
    pricePerToken: c.pricePerToken.toString(),
    currency: getAddress(c.currency),
    nativePrice: isNative(c.currency)
  };
}

/**
 * Phase reader. `call(to, data)` is an eth_call returning hex. Returns null when the contract does
 * not answer like a thirdweb Drop of the requested standard.
 */
async function readPhases(call, contract, { standard = 'erc721', tokenId = null } = {}) {
  const is1155 = standard === 'erc1155';
  if (is1155 && tokenId == null) throw new MintSpecError('An ERC-1155 thirdweb drop needs a token ID.');
  const read = is1155 ? READ_1155 : READ_721;
  const head = is1155 ? [BigInt(tokenId)] : [];
  let raw;
  try { raw = await call(contract, read.encodeFunctionData('claimCondition', head)); } catch { return null; }
  if (!raw || raw === '0x') return null;
  // Single-phase drops return the whole condition from claimCondition(); multi-phase ones return (start, count).
  if (dataLength(raw) === 64) {
    const [start, count] = coder.decode(['uint256', 'uint256'], raw);
    const n = Number(count > BigInt(MAX_PHASES) ? BigInt(MAX_PHASES) : count);
    const ids = Array.from({ length: n }, (_, i) => start + BigInt(i));
    const phases = await Promise.all(ids.map(async (id) => {
      const data = await call(contract, read.encodeFunctionData('getClaimConditionById', [...head, id]));
      return phase(id, read.decodeFunctionResult('getClaimConditionById', data)[0]);
    }));
    return { variant: 'multi-phase', standard, tokenId: tokenId == null ? null : String(tokenId), phases };
  }
  try {
    const [c] = coder.decode([CONDITION_TUPLE], raw);
    return { variant: 'single-phase', standard, tokenId: tokenId == null ? null : String(tokenId), phases: [phase(0, c)] };
  } catch { return null; }
}

/** The phase that is (or will be) active at `atSec`: the last one whose start has passed, else the next one. */
function phaseAt(phases, atSec) {
  const sorted = [...phases].sort((a, b) => a.startTimestamp - b.startTimestamp);
  const started = sorted.filter((p) => p.startTimestamp <= atSec);
  return started.length ? started[started.length - 1] : (sorted[0] || null);
}

/** Why automation cannot use this phase, or null. */
function phaseBlocker(p) {
  if (!p) return 'No claim phase is configured on this drop.';
  if (p.allowlist) return 'This phase is allowlist-only (Merkle root set); MintPilot needs a configured proof provider for it and does not guess proofs.';
  if (!p.nativePrice) return `This phase is priced in an ERC-20 token (${p.currency}); token approvals are not supported yet.`;
  return null;
}

function normalize(spec, schedule) {
  const standard = String(spec.standard || 'erc721').toLowerCase();
  if (!['erc721', 'erc1155'].includes(standard)) throw new MintSpecError('thirdweb drop standard must be erc721 or erc1155.');
  if (!isAddress(schedule.contract) || !isAddress(schedule.wallet_address)) throw new MintSpecError('Schedule contract and wallet must be addresses.');
  const target = getAddress(schedule.contract);
  const receiver = getAddress(schedule.wallet_address);
  const quantity = Number(spec.quantity ?? schedule.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) throw new MintSpecError('Quantity must be a positive integer.');
  if (schedule.quantity !== undefined && quantity !== Number(schedule.quantity)) throw new MintSpecError('thirdweb quantity does not match the schedule.');
  const price = uint(spec.pricePerToken, 'pricePerToken');
  const currency = spec.currency === undefined ? NATIVE : String(spec.currency);
  if (!isNative(currency)) throw new MintSpecError('Only native-coin thirdweb phases are supported.');
  // The public-claim proof never overrides price, currency or limit (pricePerToken = max means "no override").
  const proof = [[], 0n, MaxUint256, ZeroAddress];
  let data;
  let tokenId = null;
  if (standard === 'erc1155') {
    tokenId = uint(spec.tokenId, 'ERC-1155 token ID');
    data = CLAIM_1155.encodeFunctionData('claim', [receiver, tokenId, BigInt(quantity), NATIVE, price, proof, '0x']);
  } else {
    if (spec.tokenId !== undefined) throw new MintSpecError('tokenId applies to ERC-1155 drops only.');
    data = CLAIM_721.encodeFunctionData('claim', [receiver, BigInt(quantity), NATIVE, price, proof, '0x']);
  }
  return {
    target, data, valueWei: price * BigInt(quantity), quantity,
    label: `thirdweb ${standard === 'erc1155' ? 'ERC-1155' : 'ERC-721'} claim`,
    adapter: 'thirdweb-drop', standard, tokenId: tokenId == null ? null : tokenId.toString()
  };
}

/**
 * Revert classification for thirdweb drops. Returns null for non-thirdweb data.
 * not-open: the phase has not started (or none is active yet) — keep waiting inside the window.
 * terminal: sold out, wallet limit reached, or the price/currency changed since scheduling.
 */
function classifyRevert(data) {
  let parsed = null;
  try { parsed = data ? ERRORS.parseError(data) : null; } catch { parsed = null; }
  if (!parsed) return null;
  switch (parsed.name) {
    case 'DropClaimNotStarted': return { kind: 'not-open', startAt: Number(parsed.args[0]), reason: 'thirdweb phase has not started' };
    case 'DropNoActiveCondition': return { kind: 'not-open', startAt: null, reason: 'no thirdweb claim phase is active yet' };
    case 'DropClaimExceedLimit': return { kind: 'terminal', reason: `thirdweb wallet limit reached (limit ${parsed.args[0]}, would be ${parsed.args[1]})` };
    case 'DropClaimExceedMaxSupply': case 'DropExceedMaxSupply': return { kind: 'terminal', reason: 'thirdweb phase or collection is sold out' };
    case 'DropClaimInvalidTokenPrice': return { kind: 'terminal', reason: 'the thirdweb phase price or currency changed since scheduling; schedule again at the new price' };
    default: return null;
  }
}

const USER_KEYS = ['adapter', 'standard', 'tokenId', 'quantity'];
const STORED_KEYS = ['adapter', 'standard', 'tokenId', 'quantity', 'pricePerToken', 'currency', 'phaseId'];

module.exports = {
  id: 'thirdweb-drop', NATIVE, CLAIM_721, CLAIM_1155, READ_721, READ_1155, ERRORS,
  readPhases, phaseAt, phaseBlocker, normalize, classifyRevert, USER_KEYS, STORED_KEYS
};
