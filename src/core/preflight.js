'use strict';
// Read-only launch health check (/preflight). It runs the same preparation steps as the
// automatic executor and reports each one; it never signs, broadcasts or reserves anything.
const { resolveMintSpec } = require('./eligibilityProviders');
const { isSeaDropRoute } = require('./mintAdapters');
const { assertSeaDropRouterAuthorized } = require('./seaDropAuthorization');
const { storedSpec } = require('./prepareMint');
const { gasLimitFor } = require('./gasPolicy');
const { automationBlocker, hasSigningKey } = require('./automationPolicy');
const { Wallet } = require('ethers');
const { getCustodialPrivateKeyAsync } = require('./custodialWallets');
const { revertLabel } = require('./outcomes');
const { ProviderError } = require('./errors');

function asError(e) {
  if (e instanceof ProviderError) return e.userMessage;
  return e?.shortMessage || e?.reason || e?.message || e?.code || 'check failed';
}

async function runPreflight({ schedule, cfg, chains, rpc, buildMintTx, db = null, now = Math.floor(Date.now() / 1000), fetchImpl }) {
  const chain = chains[schedule.chain];
  const checks = [];
  const add = (name, ok, detail, extra = {}) => checks.push({ name, ok, detail, ...extra });
  let rawSpec = null;
  try { rawSpec = storedSpec(schedule); } catch { rawSpec = null; }
  const adapter = rawSpec && typeof rawSpec === 'object' ? rawSpec.adapter : null;
  const usesLiveData = adapter === 'opensea-drop' || adapter === 'seadrop-signed' || Boolean(rawSpec?.providerId);
  let provider;
  let resolvedSpec = null;
  let tx = null;

  // 1. Automatic-signing gate for this chain and value
  const blocked = automationBlocker(cfg, chains, schedule.chain, schedule.total_wei);
  add('automation', blocked === null, blocked === null ? 'Automatic signing is enabled for this network and value.' : blocked);

  // 2. Signing key present and matching the wallet
  try {
    const row = db ? db.prepare('SELECT * FROM wallets WHERE telegram_id=? AND lower(address)=lower(?)').get(String(schedule.telegram_id), String(schedule.wallet_address)) : null;
    if (!db) add('signing-key', null, 'Wallet database is not attached to this check.');
    else if (!hasSigningKey(row)) add('signing-key', false, 'The scheduled wallet has no signing key on MintPilot.');
    else {
      // Derive the address from the decrypted key itself: proves the stored key belongs to this wallet.
      const { privateKey } = await getCustodialPrivateKeyAsync(row, cfg);
      const ok = new Wallet(privateKey).address.toLowerCase() === String(schedule.wallet_address).toLowerCase();
      add('signing-key', ok, ok ? 'Encrypted signing key decrypts and matches the wallet.' : 'Signing key does not match the scheduled wallet.');
    }
  } catch (e) { add('signing-key', false, `Signing key check failed: ${asError(e)}`); }

  // 3. RPC chain ID
  try {
    if (!chain) throw new Error('Network is not configured.');
    provider = await rpc.provider(schedule.chain);
    const returned = await provider.send('eth_chainId', []);
    const chainId = Number(BigInt(returned));
    add('rpc-chain-id', chainId === chain.chainId, chainId === chain.chainId ? `RPC chain ID is ${chainId}.` : `RPC returned chain ID ${chainId}; expected ${chain.chainId}.`);
  } catch (e) { add('rpc-chain-id', false, `RPC chain ID check failed: ${asError(e)}`); }

  // 4. RPC latency
  try {
    if (!provider) throw new Error('RPC provider unavailable.');
    const before = Date.now();
    await provider.getBlockNumber();
    const ms = Date.now() - before;
    add('rpc-latency', ms < 5000, `Latest block response took ${ms} ms${ms < 5000 ? '.' : ' (too slow for a launch).'}`, { milliseconds: ms });
  } catch (e) { add('rpc-latency', false, `RPC latency check failed: ${asError(e)}`); }

  // 5. Live eligibility data (operator provider or OpenSea) and its bindings
  if (!rawSpec) {
    add('live-data', null, 'This schedule needs no live eligibility data.');
  } else {
    try {
      resolvedSpec = await resolveMintSpec(rawSpec, schedule, { now, cfg, fetchImpl });
      add('live-data', usesLiveData ? true : null, usesLiveData
        ? (adapter === 'opensea-drop' ? 'OpenSea returned a fresh transaction bound to this wallet and quantity.' : 'The configured provider returned fresh data bound to this wallet, contract, chain and quantity.')
        : 'Inline eligibility data is present; it is checked by the simulation below.');
    } catch (e) { add('live-data', false, `Live eligibility data unavailable: ${asError(e)}`); }
  }

  // 6. Phase window (SeaDrop signed mints carry it in MintParams)
  try {
    const phase = resolvedSpec?.mintParams;
    if (phase) {
      const chainNow = await rpc.getChainTime(schedule.chain);
      const active = BigInt(phase.startTime) <= BigInt(chainNow) && BigInt(chainNow) < BigInt(phase.endTime);
      add('phase-window', active, active ? `SeaDrop phase is active at chain time ${chainNow}.` : `SeaDrop phase is not active at chain time ${chainNow}; window is ${phase.startTime}–${phase.endTime}.`);
    } else add('phase-window', null, 'No signed phase window applies; the simulation below checks whether the mint is open.');
  } catch (e) { add('phase-window', false, `Phase check failed: ${asError(e)}`); }

  // 7. Exact transaction
  try {
    if (rawSpec && !resolvedSpec) throw new Error('live eligibility data is unavailable');
    tx = resolvedSpec ? buildMintTx({ ...schedule, mint_spec: JSON.stringify(resolvedSpec), mintSpec: resolvedSpec }) : buildMintTx(schedule);
    add('transaction', true, `Built ${tx.mintLabel || 'mint'} to ${tx.to} for ${tx.valueWei} wei.`);
  } catch (e) { add('transaction', false, `Final transaction could not be built: ${asError(e)}`); }

  // 8. SeaDrop router authorization (every SeaDrop route)
  if (tx && isSeaDropRoute(adapter)) {
    try {
      await assertSeaDropRouterAuthorized(rpc, schedule, tx);
      add('router-authorized', true, `SeaDrop router ${tx.to} is authorized by the NFT contract.`);
    } catch (e) { add('router-authorized', false, `SeaDrop authorization check failed: ${asError(e)}`); }
  } else add('router-authorized', null, 'SeaDrop router authorization is not applicable to this schedule.');

  // 9. Wallet balance vs mint value
  let balance = null;
  try {
    balance = BigInt(await rpc.getBalance(schedule.chain, schedule.wallet_address));
    const value = tx?.pending ? 0n : BigInt(tx?.valueWei ?? schedule.total_wei ?? 0); // a pending OpenSea tx only carries the price ceiling
    add('wallet-balance', balance >= value, balance >= value ? `Wallet has ${balance} wei for a ${value} wei mint value; gas is checked next.` : `Wallet has ${balance} wei but the mint value is ${value} wei.`);
  } catch (e) { add('wallet-balance', false, `Wallet balance check failed: ${asError(e)}`); }

  // 10. Gas estimate, policy cap and reserve
  try {
    if (!provider || !tx) throw new Error('Provider or final transaction unavailable.');
    const estimate = BigInt(await provider.estimateGas({ from: schedule.wallet_address, to: tx.to, data: tx.data, value: BigInt(tx.valueWei) }));
    const policy = gasLimitFor(cfg, estimate, tx.quantity, schedule.chain);
    const feeData = typeof provider.getFeeData === 'function' ? await provider.getFeeData() : {};
    const fee = feeData.maxFeePerGas || feeData.gasPrice;
    const reserve = !policy.ok || fee == null ? 0n : policy.gasLimit * BigInt(fee);
    const enough = policy.ok && balance != null && balance >= (tx.pending ? 0n : BigInt(tx.valueWei)) + reserve;
    const detail = !policy.ok
      ? `Gas estimate ${estimate} exceeds the cap ${policy.cap} for ${tx.quantity} token(s).`
      : `Gas estimate ${estimate}; gas limit ${policy.gasLimit} (cap ${policy.cap}); reserve ${reserve} wei${enough ? '.' : ' — wallet cannot cover value plus gas.'}`;
    add('gas-estimate', enough, detail, { estimatedGas: String(estimate), gasLimit: policy.gasLimit?.toString() ?? null, gasCap: policy.cap.toString() });
  } catch (e) { add('gas-estimate', false, `Gas estimation failed: ${e?.data ? revertLabel(e.data, asError(e)) : asError(e)}`); }

  // 11. Exact eth_call simulation
  try {
    if (!tx) throw new Error('Final transaction unavailable.');
    const simulation = await rpc.simulate(schedule.chain, tx);
    add('simulation', simulation.ok === true, simulation.ok ? 'Exact final transaction simulation passed.' : `Exact final transaction simulation failed: ${revertLabel(simulation.data, simulation.reason || 'reverted')}`);
  } catch (e) { add('simulation', false, `Simulation failed: ${asError(e)}`); }

  // 12. Pending nonce availability
  try {
    if (!provider || typeof provider.getTransactionCount !== 'function') throw new Error('RPC provider does not expose nonce reads.');
    const latest = await provider.getTransactionCount(schedule.wallet_address, 'latest');
    const pending = await provider.getTransactionCount(schedule.wallet_address, 'pending');
    add('nonce-available', pending === latest, pending === latest ? `Nonce ${pending} is available with no pending nonce gap.` : `Wallet has pending nonce ${pending}; latest confirmed nonce is ${latest}.`);
  } catch (e) { add('nonce-available', false, `Nonce check failed: ${asError(e)}`); }

  // 13. Existing submission / reconciliation guard
  try {
    if (!db) add('submission-state', null, 'Submission-state database is not attached to this check.');
    else {
      const attempt = db.prepare(`SELECT status, tx_hash, fire_at_ms FROM execution_attempts WHERE schedule_id=? AND status IN ('armed','submitting','uncertain','submitted') ORDER BY id DESC LIMIT 1`).get(schedule.id);
      const tracked = db.prepare("SELECT 1 FROM tracked_txs WHERE schedule_id=? AND status IN ('pending','confirmed') LIMIT 1").get(schedule.id);
      if (attempt && attempt.status === 'armed' && !tracked) {
        add('submission-state', true, `Pre-signed and armed; it will be sent at ${new Date(Number(attempt.fire_at_ms)).toISOString()}.`);
      } else {
        const ok = !attempt && !tracked;
        add('submission-state', ok, ok ? 'No prior automatic submission or tracked transaction blocks execution.' : 'A prior submission or tracked transaction exists for this schedule.');
      }
    }
  } catch (e) { add('submission-state', false, `Submission-state check failed: ${asError(e)}`); }

  const failures = checks.filter((c) => c.ok === false);
  return {
    scheduleId: schedule.id,
    wallet: schedule.wallet_address,
    chain: schedule.chain,
    contract: schedule.contract,
    checks,
    ready: Boolean(chain && failures.length === 0 && checks.find((c) => c.name === 'simulation')?.ok === true),
    transaction: tx ? { to: tx.to, valueWei: String(tx.valueWei), adapter: tx.adapter || null, quantity: tx.quantity } : null,
    observedAt: now
  };
}

module.exports = { runPreflight };
