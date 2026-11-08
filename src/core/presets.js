'use strict';
// Allow-list of supported mint call shapes. The bot NEVER accepts arbitrary calldata:
// users pick one of these presets, and calldata is encoded from validated fields only.
const PRESETS = [
  { id: 'mint()',                label: 'mint()',                       usesQuantity: false, priceIsTotal: true  },
  { id: 'mint(uint256)',         label: 'mint(quantity)',               usesQuantity: true,  priceIsTotal: false },
  { id: 'publicMint(uint256)',   label: 'publicMint(quantity)',         usesQuantity: true,  priceIsTotal: false },
  { id: 'mint(address,uint256)', label: 'mint(to, quantity)',           usesQuantity: true,  priceIsTotal: false },
  { id: 'safeMint(address,uint256)', label: 'safeMint(to, quantity)',    usesQuantity: true,  priceIsTotal: false },
  { id: 'publicMint(address,uint256)', label: 'publicMint(to, quantity)', usesQuantity: true, priceIsTotal: false }
];
const byId = (id) => PRESETS.find((p) => p.id === id);

/** total value = price * quantity for quantity-based presets, else just price */
function totalWei(presetId, priceWei, quantity) {
  const p = byId(presetId);
  if (!p) throw new Error('Unknown mint method.');
  return p.usesQuantity ? BigInt(priceWei) * BigInt(quantity) : BigInt(priceWei);
}
module.exports = { PRESETS, byId, totalWei };
