'use strict';
const { parseEther } = require('ethers');

/**
 * Null when this deployment may automatically sign a mint on `chainKey` worth `totalWei`,
 * otherwise a user-readable reason. Used both when a schedule is created (refuse early)
 * and immediately before signing (configuration may have changed since).
 * Every chain in the registry is a mainnet: AUTOMATION_ALLOWED_CHAINS decides where signing is on.
 */
function automationBlocker(cfg, chains, chainKey, totalWei = null) {
  const a = cfg.automation;
  if (a.enabled !== true || !a.encryptionKey) return 'Automatic signing is not configured on this deployment (AUTOMATION_ENABLED and AUTOMATION_MASTER_KEY).';
  const chain = chains[chainKey];
  if (!chain) return 'This network is not enabled on this deployment.';
  if (!a.allowedChains.includes(chainKey)) return `Automatic signing is not enabled for ${chain.name}.`;
  if (totalWei != null && BigInt(totalWei) > parseEther(a.maxValueEth)) return `The mint value exceeds the ${a.maxValueEth} ETH automatic-signing cap.`;
  return null;
}

/** True when the wallet row holds an encrypted signing key MintPilot can use. */
const hasSigningKey = (row) => Boolean(row && row.ciphertext && row.iv && row.auth_tag && row.salt);

module.exports = { automationBlocker, hasSigningKey };
