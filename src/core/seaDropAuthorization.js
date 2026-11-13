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
async function assertSeaDropRouterAuthorized(rpc, schedule, tx, { trustedRouters = [] } = {}) {
  if (!rpc || typeof rpc.getAllowedSeaDrop !== 'function') throw new Error('RPC layer does not expose SeaDrop authorization reads.');
  const target = String(tx?.to || tx?.target || '').toLowerCase();
  let allowed;
  try { allowed = await rpc.getAllowedSeaDrop(schedule.chain, schedule.contract); }
  catch (e) {
    if (isPermanentReadFailure(e)) {
      // Some drop contracts have no SeaDrop list at all. Accept only destinations MintPilot can vouch for: the
      // collection's own contract (the one you scheduled) or a router the operator has trusted explicitly.
      const trusted = new Set([String(schedule.contract).toLowerCase(), ...trustedRouters.map((a) => String(a).toLowerCase())]);
      if (target && trusted.has(target)) return true;
      throw new MintSpecError(`MintPilot cannot verify the mint route for this collection: OpenSea sends the mint to ${tx?.to || tx?.target || '(missing)'}, and the contract does not publish a SeaDrop authorization list to check it against. Nothing was sent. You can mint this one manually, or ask support to review the route.`);
    }
    e.retryable = true; throw e;
  }
  if (!Array.isArray(allowed) || !allowed.some((address) => String(address).toLowerCase() === target)) {
    throw new MintSpecError(`SeaDrop router ${tx?.to || tx?.target || '(missing)'} is not authorized by the scheduled NFT contract.`);
  }
  return true;
}

module.exports = { assertSeaDropRouterAuthorized };
