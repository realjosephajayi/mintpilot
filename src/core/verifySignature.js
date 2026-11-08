'use strict';
const { verifyMessage, hashMessage, Contract } = require('ethers');
const ERC1271_MAGIC = '0x1626ba7e';

/**
 * Prove that `address` produced `signature` over `message`.
 *  1. EOA: ecrecover (EIP-191 personal_sign).
 *  2. Smart-contract wallets (Safe, Coinbase Smart Wallet): ERC-1271 isValidSignature on `provider`.
 * Undeployed (counterfactual, ERC-6492) wallets are not supported.
 */
async function verifyWalletSignature({ message, signature, address, provider }) {
  try {
    if (verifyMessage(message, signature).toLowerCase() === address.toLowerCase()) return { ok: true, type: 'eoa' };
  } catch { /* malformed signature or not an EOA signature — fall through */ }
  if (provider) {
    try {
      if ((await provider.getCode(address)) !== '0x') {
        const c = new Contract(address, ['function isValidSignature(bytes32,bytes) view returns (bytes4)'], provider);
        if ((await c.isValidSignature(hashMessage(message), signature)) === ERC1271_MAGIC) return { ok: true, type: 'erc1271' };
      }
    } catch { /* wallet does not implement ERC-1271 */ }
  }
  return { ok: false };
}
module.exports = { verifyWalletSignature, ERC1271_MAGIC };
