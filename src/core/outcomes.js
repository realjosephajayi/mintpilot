'use strict';
// One vocabulary for every automatic-execution result. The worker switches on
// `outcome`; it never parses error text. See docs/adr/0002-execution-outcomes.md.
const { Interface } = require('ethers');
const { UserError } = require('../util/format');
const { MintSpecError, ProviderError } = require('./errors');
const thirdweb = require('./adapters/thirdweb');

const OUTCOME = Object.freeze({
  SUBMITTED: 'submitted', // signed tx accepted by the node; hash recorded
  WAIT: 'wait',           // mint not open yet, or wallet needs funds: try again until the deadline
  RETRY: 'retry',         // transient (RPC, provider 5xx/429, rate limit): try again with backoff
  TERMINAL: 'terminal',   // cannot succeed as configured: fail once and notify
  UNCERTAIN: 'uncertain', // signed and possibly broadcast: reconcile by hash, never re-sign
  DRY_RUN: 'dry-run',     // every check passed; nothing was signed or sent
  LEASE_LOST: 'lease-lost'// another worker owns the wallet now; do nothing
});

// SeaDrop V1 custom errors, from ProjectOpenSea/seadrop src/lib/SeaDropErrorsAndEvents.sol.
const SEADROP_ERRORS = new Interface([
  'error NotActive(uint256 currentTimestamp, uint256 startTimestamp, uint256 endTimestamp)',
  'error MintQuantityCannotBeZero()',
  'error MintQuantityExceedsMaxMintedPerWallet(uint256 total, uint256 allowed)',
  'error MintQuantityExceedsMaxSupply(uint256 total, uint256 maxSupply)',
  'error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total, uint256 maxTokenSupplyForStage)',
  'error FeeRecipientNotAllowed()',
  'error IncorrectPayment(uint256 got, uint256 want)',
  'error InvalidProof()',
  'error InvalidSignature(address recoveredSigner)',
  'error PayerNotAllowed()',
  'error TokenGatedNotTokenOwner(address nftContract, address allowedNftToken, uint256 allowedNftTokenId)',
  'error TokenGatedTokenIdAlreadyRedeemed(address nftContract, address allowedNftToken, uint256 allowedNftTokenId)'
]);

function decodeSeaDropError(data) {
  if (typeof data !== 'string' || data.length < 10) return null;
  try { return SEADROP_ERRORS.parseError(data); } catch { return null; }
}

/**
 * Classify a simulation/estimate revert.
 * - SeaDrop NotActive before the stage end -> WAIT; any other decoded SeaDrop error -> TERMINAL.
 * - thirdweb DropClaimNotStarted / DropNoActiveCondition -> WAIT (bounded by the schedule deadline);
 *   sold out, wallet limit, changed price -> TERMINAL.
 * - Unknown contracts: a revert counts as "not open yet" only until launchAt + graceSec.
 */
function classifyRevert(data, { chainTime, launchAt, graceSec }) {
  const decoded = decodeSeaDropError(data);
  if (decoded?.name === 'NotActive') {
    return BigInt(chainTime) < BigInt(decoded.args.endTimestamp) ? OUTCOME.WAIT : OUTCOME.TERMINAL;
  }
  if (decoded) return OUTCOME.TERMINAL;
  const tw = thirdweb.classifyRevert(data);
  if (tw) return tw.kind === 'not-open' ? OUTCOME.WAIT : OUTCOME.TERMINAL;
  if (launchAt != null && Number(chainTime) < Number(launchAt) + Number(graceSec || 0)) return OUTCOME.WAIT;
  return OUTCOME.TERMINAL;
}

/** For a not-yet-open revert that names its start (SeaDrop NotActive, thirdweb DropClaimNotStarted), that start time (seconds); else null. */
function notActiveStart(data, chainTime) {
  const decoded = decodeSeaDropError(data);
  const tw = decoded ? null : thirdweb.classifyRevert(data);
  if (tw?.kind === 'not-open' && tw.startAt != null) return tw.startAt > Number(chainTime) ? tw.startAt : null;
  if (decoded?.name !== 'NotActive') return null;
  const start = Number(decoded.args.startTimestamp);
  return Number.isFinite(start) && start > Number(chainTime) ? start : null;
}

function revertLabel(data, fallback) {
  const decoded = decodeSeaDropError(data);
  if (!decoded) {
    const tw = thirdweb.classifyRevert(data);
    return tw ? tw.reason : (fallback || 'the contract reverted');
  }
  const labels = {
    NotActive: 'the drop stage is not active',
    MintQuantityExceedsMaxMintedPerWallet: 'the per-wallet mint limit would be exceeded',
    MintQuantityExceedsMaxSupply: 'the collection is sold out for this quantity',
    MintQuantityExceedsMaxTokenSupplyForStage: 'the stage supply is exhausted for this quantity',
    IncorrectPayment: 'the payment amount is wrong for this stage',
    InvalidProof: 'this wallet is not on the allowlist (its allowlist proof is invalid)',
    InvalidSignature: 'the mint signature is invalid',
    FeeRecipientNotAllowed: 'the fee recipient is not allowed by this drop',
    PayerNotAllowed: 'this wallet is not on the allowed list for this drop',
    TokenGatedNotTokenOwner: 'the wallet does not own the required gate token',
    TokenGatedTokenIdAlreadyRedeemed: 'the gate token was already redeemed',
    MintQuantityCannotBeZero: 'the mint quantity is zero'
  };
  return labels[decoded.name] || decoded.name;
}

const OPENSEA_TERMINAL = new Set(['MINTER_NOT_ELIGIBLE', 'MINT_LIMIT_EXCEEDED', 'SUPPLY_EXHAUSTED', 'NO_PAYOUT_ADDRESS', 'UNSUPPORTED_DROP_TYPE', 'DROP_NOT_FOUND']);

/** Map an error thrown while resolving/building/authorizing a mint to an outcome. */
function classifyPreparationError(e) {
  if (e?.name === 'OpenSeaApiError') {
    const code = e.apiCode || null;
    // apiCost: every OpenSea attempt spends a shared API write, so these waits back off.
    if (code === 'NOT_MINTING' || (!code && e.status === 409)) return { outcome: OUTCOME.WAIT, apiCost: true, userReason: 'OpenSea reports the drop is not minting yet.', retryAfterSec: e.retryAfterSec };
    if (code === 'INSUFFICIENT_BALANCE') return { outcome: OUTCOME.WAIT, apiCost: true, notify: 'funds', userReason: 'OpenSea reports the wallet cannot pay the price plus gas. Top up the wallet before the stage ends.' };
    if (e.retryable) return { outcome: OUTCOME.RETRY, userReason: 'OpenSea is rate limiting or temporarily unavailable.', retryAfterSec: e.retryAfterSec };
    // Say plainly why the wallet was refused instead of echoing the raw API text.
    if (code === 'MINTER_NOT_ELIGIBLE' || (e.status === 422 && /allow ?list|not eligible|not on the/i.test(String(e.message)))) return { outcome: OUTCOME.TERMINAL, ineligible: true, userReason: 'This wallet is not on the allowlist (eligible list) for this mint stage, so it cannot mint. Nothing was sent. Use a wallet that is on the list, or check the stage requirements on the project page.' };
    if (code === 'MINT_LIMIT_EXCEEDED') return { outcome: OUTCOME.TERMINAL, userReason: 'This wallet has already reached the per-wallet mint limit for this stage, so nothing was sent. If you already minted from this wallet yourself, that counts toward the limit.' };
    if (code === 'SUPPLY_EXHAUSTED') return { outcome: OUTCOME.TERMINAL, userReason: 'This collection or stage is minted out. Nothing was sent.' };
    if (OPENSEA_TERMINAL.has(code) || (e.status >= 400 && e.status < 500)) return { outcome: OUTCOME.TERMINAL, userReason: e.message };
    return { outcome: OUTCOME.RETRY, userReason: 'OpenSea request failed; retrying.', retryAfterSec: e.retryAfterSec };
  }
  if (e instanceof ProviderError) return { outcome: e.retryable ? OUTCOME.RETRY : OUTCOME.TERMINAL, userReason: e.userMessage };
  if (e instanceof MintSpecError || e instanceof UserError) return { outcome: OUTCOME.TERMINAL, userReason: e.message };
  if (e?.retryable) return { outcome: OUTCOME.RETRY, userReason: 'A required on-chain read is temporarily unavailable; retrying.' };
  // Unknown failure: retry with backoff. The schedule deadline bounds how long this can continue.
  return { outcome: OUTCOME.RETRY, userReason: 'Mint preparation failed temporarily; retrying.' };
}

/**
 * Errors from eth_sendRawTransaction that prove the node REJECTED the tx (so it was
 * never broadcast). Codes as mapped by ethers v6 JsonRpcApiProvider. Anything else is
 * ambiguous and must be reconciled by hash. Returns null for ambiguous errors.
 */
function errorMessage(e) {
  return [e?.shortMessage, e?.message, e?.info?.error?.message, e?.error?.message].filter(Boolean).join(' | ');
}

/**
 * `immediate`: re-sign and resend now (inside a launch the fast loop does not wait for a tick).
 * NONCE_EXPIRED is only trusted after the executor confirms its own hash is NOT on-chain: on a
 * 100 ms chain a parallel broadcast can see our own transaction mined and answer "nonce too low".
 */
function classifyBroadcastError(e) {
  switch (e?.code) {
    case 'INSUFFICIENT_FUNDS': return { outcome: OUTCOME.WAIT, notify: 'funds', userReason: 'The node rejected the transaction: insufficient funds for value plus gas.' };
    case 'NONCE_EXPIRED': return { outcome: OUTCOME.RETRY, immediate: true, nonceUsed: true, userReason: 'The wallet nonce was already used by another transaction; re-signing with a fresh nonce.' };
    case 'REPLACEMENT_UNDERPRICED': return { outcome: OUTCOME.RETRY, userReason: 'Another pending transaction uses this nonce; retrying later.' };
    case 'CALL_EXCEPTION': return { outcome: OUTCOME.TERMINAL, userReason: 'The node rejected the transaction as a revert.' };
    default: break;
  }
  const message = errorMessage(e);
  if (/max fee per gas less than block base fee|fee cap less than block base fee|feecap .* below|transaction underpriced/i.test(message)) {
    return { outcome: OUTCOME.RETRY, immediate: true, userReason: 'The base fee rose above the signed fee cap; re-signing with fresh fees.' };
  }
  if (/intrinsic gas too low|exceeds block gas limit|gas limit reached/i.test(message)) {
    // gasLimitRejected: a pre-signed (armed) transaction carries the configured cap, not an estimate;
    // the launch engine re-signs from a fresh estimate instead of stopping.
    return { outcome: OUTCOME.TERMINAL, gasLimitRejected: true, userReason: 'The node rejected the transaction gas limit.' };
  }
  return null;
}

/**
 * Seconds until the next attempt after `attempts` consecutive RETRY/API-costly deferrals.
 * The first attempts follow the 15 s worker tick closely. (Chain-side WAITs do not back off.)
 */
function backoffSec(attempts, retryAfterSec = null) {
  const n = Math.max(0, Number(attempts) || 0);
  const base = n < 4 ? 0 : Math.min(300, 15 * 2 ** (n - 3)); // 0,0,0,0,30,60,120,240,300...
  return Math.max(base, Number(retryAfterSec) || 0);
}

module.exports = { OUTCOME, SEADROP_ERRORS, decodeSeaDropError, classifyRevert, notActiveStart, revertLabel, classifyPreparationError, classifyBroadcastError, backoffSec };
