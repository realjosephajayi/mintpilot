'use strict';
// Fee fields for an automatically signed mint, set explicitly so signing needs no RPC call.
//
//   tip          = PRIORITY_FEE_GWEI_JSON[chain] when set
//                  else 0 on first-come-first-served chains (chain.ordering === 'fcfs': position is
//                  decided by arrival time, a tip buys nothing)
//                  else the RPC's eth_maxPriorityFeePerGas suggestion
//   maxFeePerGas = ceil(baseFee × multiplier) + tip
//
// EIP-1559 charges the block's actual base fee, so the multiplier is headroom against a rising base
// fee, not extra cost; it only raises the balance the wallet must hold (gasLimit × maxFeePerGas).
const { parseUnits } = require('ethers');

function tipFor(chain, cfg, suggestedTip) {
  const override = cfg.fees?.priorityFeeGwei?.[chain.key];
  if (override !== undefined && override !== null) return parseUnits(String(override), 'gwei');
  if (chain.ordering === 'fcfs') return 0n;
  return suggestedTip == null ? 0n : BigInt(suggestedTip);
}

/**
 * @param inputs { baseFeePerGas, priorityFeePerGas, gasPrice } from rpc.getFeeInputs
 * @returns { type: 2, maxFeePerGas, maxPriorityFeePerGas, maxCost } or { type: 0, gasPrice, maxCost }
 *          maxCost is the per-gas amount the balance check must reserve.
 */
function feeFields(chain, cfg, inputs, multiplierBps = cfg.fees?.baseMultiplierBps ?? 20000) {
  if (inputs?.baseFeePerGas == null) {
    if (inputs?.gasPrice == null) throw new Error('Fee data unavailable.');
    const gasPrice = BigInt(inputs.gasPrice);
    return { type: 0, gasPrice, maxCost: gasPrice };
  }
  const base = BigInt(inputs.baseFeePerGas);
  const tip = tipFor(chain, cfg, inputs.priorityFeePerGas);
  const bps = BigInt(Math.max(10000, Number(multiplierBps) || 10000));
  const maxFeePerGas = (base * bps + 9999n) / 10000n + tip;
  return { type: 2, maxFeePerGas, maxPriorityFeePerGas: tip, maxCost: maxFeePerGas };
}

/** Transaction fields for signing (no maxCost). */
function txFeeFields(fees) {
  return fees.type === 0
    ? { type: 0, gasPrice: fees.gasPrice }
    : { type: 2, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
}

module.exports = { feeFields, tipFor, txFeeFields };
