'use strict';
const { checkEligibility } = require('./eligibility');
const { normalizeAddress } = require('./wallets');
const { resolveAndBuild } = require('./prepareMint');
const { revertLabel } = require('./outcomes');
const { ProviderError } = require('./errors');

async function checkMintReadiness({ schedule, cfg, chains, rpc, buildMintTx, db = null, now = Math.floor(Date.now() / 1000) }) {
  const result = {
    scheduleId: schedule.id,
    wallet: normalizeAddress(schedule.wallet_address),
    chain: schedule.chain,
    contract: schedule.contract,
    listedInEligibilityFile: null,
    contractExists: null,
    nativeBalanceWei: null,
    requiredMintWei: String(schedule.total_wei),
    tokenGate: null,
    nftBalance: null,
    alreadyTrackedMint: false,
    simulation: { ok: false, reason: 'not checked' },
    checks: []
  };

  try {
    result.listedInEligibilityFile = checkEligibility(result.wallet, cfg.eligibilityFile).listed;
    result.checks.push({ name: 'allowlist-file', ok: result.listedInEligibilityFile, advisory: true,
      detail: result.listedInEligibilityFile ? 'Wallet is listed in the configured eligibility file.' : 'Wallet is not listed in the configured eligibility file.' });
  } catch (e) {
    result.checks.push({ name: 'allowlist-file', ok: false, advisory: true, detail: e.message });
  }

  try {
    result.contractExists = await rpc.hasCode(schedule.chain, schedule.contract);
    result.checks.push({ name: 'contract', ok: result.contractExists, detail: result.contractExists ? 'Contract bytecode detected.' : 'No contract bytecode detected.' });
  } catch (e) {
    result.checks.push({ name: 'contract', ok: false, detail: `Contract check unavailable: ${e.message}` });
  }

  try {
    result.nativeBalanceWei = await rpc.getBalance(schedule.chain, result.wallet);
    const funded = BigInt(result.nativeBalanceWei) >= BigInt(result.requiredMintWei);
    result.checks.push({ name: 'funding', ok: funded, detail: funded ? 'Wallet covers the mint value; gas is checked separately by the wallet/RPC.' : 'Wallet balance is below the configured mint value.' });
  } catch (e) {
    result.checks.push({ name: 'funding', ok: false, detail: `Balance check unavailable: ${e.message}` });
  }

  try {
    result.nftBalance = await rpc.getErc721Balance(schedule.chain, schedule.contract, result.wallet);
    result.checks.push({ name: 'ownership', ok: true, advisory: true, detail: `${result.nftBalance} NFT(s) currently owned from this contract.` });
  } catch {
    result.checks.push({ name: 'ownership', ok: null, advisory: true, detail: 'The contract does not expose a readable ERC-721 balanceOf call.' });
  }

  if (db) {
    const tracked = db.prepare("SELECT 1 FROM tracked_txs WHERE schedule_id=? AND status='confirmed' LIMIT 1").get(schedule.id);
    result.alreadyTrackedMint = Boolean(tracked);
    result.checks.push({ name: 'mint-history', ok: !result.alreadyTrackedMint, advisory: true,
      detail: result.alreadyTrackedMint ? 'A confirmed transaction is already recorded for this schedule.' : 'No confirmed MintPilot transaction is recorded for this schedule.' });
  }

  let mintSpec = null;
  try { mintSpec = schedule.mint_spec ? JSON.parse(schedule.mint_spec) : (schedule.mintSpec || null); } catch { /* buildMintTx reports malformed persisted specs below */ }
  if (mintSpec?.adapter === 'token') {
    try {
      const balance = await rpc.getTokenBalance(schedule.chain, mintSpec.standard || 'erc721', mintSpec.gateContract, result.wallet, mintSpec.tokenId);
      const required = BigInt(mintSpec.minBalance ?? 1);
      result.tokenGate = { balance, required: required.toString(), standard: mintSpec.standard || 'erc721', gateContract: mintSpec.gateContract, ok: BigInt(balance) >= required };
      result.checks.push({ name: 'token-gate', ok: result.tokenGate.ok, detail: `Token gate balance is ${balance}; at least ${required} required.` });
    } catch (e) {
      result.tokenGate = { ok: false, error: e.message };
      result.checks.push({ name: 'token-gate', ok: false, detail: `Token gate check unavailable: ${e.message}` });
    }
  }

  try {
    // Same resolve -> build -> SeaDrop router check path the executor uses.
    const { tx } = await resolveAndBuild(schedule, { rpc, cfg, now, buildMintTx });
    const simulation = await rpc.simulate(schedule.chain, tx);
    result.simulation = simulation;
    result.checks.push({ name: 'preflight', ok: simulation.ok, detail: simulation.ok ? 'Mint transaction simulation passed.' : `Simulation failed: ${revertLabel(simulation.data, simulation.reason || 'reverted')}` });
  } catch (e) {
    result.checks.push({ name: 'preflight', ok: false, detail: `Simulation unavailable: ${e instanceof ProviderError ? e.userMessage : e.message}` });
  }

  result.ready = result.contractExists === true
    && result.simulation.ok === true
    && result.nativeBalanceWei != null
    && BigInt(result.nativeBalanceWei) >= BigInt(result.requiredMintWei)
    && (result.tokenGate == null || result.tokenGate.ok === true)
    && !result.alreadyTrackedMint;
  return result;
}

module.exports = { checkMintReadiness };
