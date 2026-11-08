'use strict';
const { Interface } = require('ethers');
const { byId, totalWei } = require('./presets');
const { buildFromSpec } = require('./mintAdapters');
const { MintSpecError } = require('./errors');

const iface = new Interface([
  'function mint() payable',
  'function mint(uint256 quantity) payable',
  'function publicMint(uint256 quantity) payable',
  'function mint(address to, uint256 quantity) payable',
  'function safeMint(address to, uint256 quantity) payable',
  'function publicMint(address to, uint256 quantity) payable'
]);

// Adapters whose live value may be LOWER than the stored amount: the stored total is a ceiling.
// (OpenSea builds the tx from the active stage; SeaDrop signed mints take the provider's mintPrice.)
const CEILING_ADAPTERS = new Set(['opensea-drop', 'seadrop-signed']);

/**
 * Build the unsigned transaction for a stored schedule. Provider-backed specs must
 * be resolved first (see prepareMint); an unresolved spec is never turned into calldata.
 * Gas is not fixed here: the executor derives the limit from a fresh estimate (gasPolicy).
 */
function buildMintTx(schedule) {
  if (schedule.mint_spec || schedule.mintSpec) {
    const adapted = buildFromSpec(schedule.mintSpec || schedule.mint_spec, schedule);
    if (adapted.pending || adapted.deferred) throw new MintSpecError('Mint eligibility data must be fetched from its provider before the transaction can be built.');
    if (CEILING_ADAPTERS.has(adapted.adapter)) {
      if (schedule.total_wei === undefined) throw new MintSpecError('Mint schedule is missing its spend ceiling.');
      const ceiling = BigInt(schedule.total_wei);
      if (adapted.valueWei > ceiling) throw new MintSpecError(`Live mint value ${adapted.valueWei} wei exceeds the scheduled spend ceiling ${ceiling} wei.`);
      if (adapted.adapter === 'opensea-drop' && schedule.price_wei !== undefined && BigInt(adapted.quantity) * BigInt(schedule.price_wei) !== ceiling) {
        throw new MintSpecError('Stored OpenSea spend ceiling does not match the schedule.');
      }
    } else if (schedule.total_wei !== undefined && BigInt(schedule.total_wei) !== adapted.valueWei) {
      throw new MintSpecError('Stored mint value does not match the adapter configuration.');
    }
    return {
      from: schedule.wallet_address, to: adapted.target, data: adapted.data,
      value: '0x' + adapted.valueWei.toString(16), valueWei: adapted.valueWei.toString(),
      adapter: adapted.adapter, eligibility: adapted.eligibility || null, mintLabel: adapted.label, quantity: adapted.quantity
    };
  }
  const p = byId(schedule.preset);
  if (!p) throw new MintSpecError('Unknown mint method.');
  let args = [];
  if (p.id === 'mint(uint256)' || p.id === 'publicMint(uint256)') args = [BigInt(schedule.quantity)];
  if (p.id === 'mint(address,uint256)' || p.id === 'safeMint(address,uint256)' || p.id === 'publicMint(address,uint256)') args = [schedule.wallet_address, BigInt(schedule.quantity)];
  const data = iface.encodeFunctionData(p.id, args);
  const value = totalWei(p.id, schedule.price_wei, schedule.quantity);
  return { from: schedule.wallet_address, to: schedule.contract, data, value: '0x' + value.toString(16), valueWei: value.toString(), adapter: 'preset', mintLabel: p.label, quantity: p.usesQuantity ? Number(schedule.quantity) : 1 };
}

module.exports = { buildMintTx };
