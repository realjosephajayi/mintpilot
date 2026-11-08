'use strict';
const { MintSpecError } = require('./errors');

/**
 * The SeaDrop router a transaction calls must be in the scheduled NFT contract's
 * getAllowedSeaDrop() list. A failed read is retryable; an unlisted router is not.
 */
async function assertSeaDropRouterAuthorized(rpc, schedule, tx) {
  if (!rpc || typeof rpc.getAllowedSeaDrop !== 'function') throw new Error('RPC layer does not expose SeaDrop authorization reads.');
  let allowed;
  try { allowed = await rpc.getAllowedSeaDrop(schedule.chain, schedule.contract); }
  catch (e) { e.retryable = true; throw e; }
  const target = String(tx?.to || tx?.target || '').toLowerCase();
  if (!Array.isArray(allowed) || !allowed.some((address) => String(address).toLowerCase() === target)) {
    throw new MintSpecError(`SeaDrop router ${tx?.to || tx?.target || '(missing)'} is not authorized by the scheduled NFT contract.`);
  }
  return true;
}

module.exports = { assertSeaDropRouterAuthorized };
