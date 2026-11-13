'use strict';
const { MintSpecError } = require('./errors');

// A contract that answers with nothing, reverts, or returns data that cannot be decoded does not publish the list.
// Retrying will never change that, so it must not be treated like a network hiccup.
const isPermanentReadFailure = (e) => {
  const text = `${e?.code || ''} ${e?.shortMessage || ''} ${e?.message || ''}`;
  return /CALL_EXCEPTION|BAD_DATA|could not decode result data|execution reverted/i.test(text);
};

/**
 * The SeaDrop router a transaction calls must be in the scheduled NFT contract's
 * getAllowedSeaDrop() list. A network failure while reading it is retryable; a contract that does not
 * publish the list, or an unlisted router, is not.
 */
async function assertSeaDropRouterAuthorized(rpc, schedule, tx) {
  if (!rpc || typeof rpc.getAllowedSeaDrop !== 'function') throw new Error('RPC layer does not expose SeaDrop authorization reads.');
  let allowed;
  try { allowed = await rpc.getAllowedSeaDrop(schedule.chain, schedule.contract); }
  catch (e) {
    if (isPermanentReadFailure(e)) throw new MintSpecError('This collection\'s contract does not publish a SeaDrop authorization list, so MintPilot cannot verify the mint route. Nothing was sent. You can mint this one manually.');
    e.retryable = true; throw e;
  }
  const target = String(tx?.to || tx?.target || '').toLowerCase();
  if (!Array.isArray(allowed) || !allowed.some((address) => String(address).toLowerCase() === target)) {
    throw new MintSpecError(`SeaDrop router ${tx?.to || tx?.target || '(missing)'} is not authorized by the scheduled NFT contract.`);
  }
  return true;
}

module.exports = { assertSeaDropRouterAuthorized };
