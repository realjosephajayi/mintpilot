'use strict';
// Automatic custodial execution. MintPilot never asks users to sign: every mint is
// prepared, checked, signed with the wallet's encrypted key and broadcast here.
//
// Two ways a transaction is produced (docs/adr/0005-launch-engine.md):
//
//   execute()  direct: build -> [router check ‖ simulate ‖ estimate ‖ balance ‖ fees+chain time ‖ nonce]
//              (one parallel round trip) -> sign locally with explicit fields (no RPC) -> persist hash +
//              nonce + raw -> broadcast to every endpoint at once -> classify.
//   arm()      before a launch: the same checks, then sign with the gas cap as limit (the estimate reverts
//              while the stage is closed) and persist the attempt as 'armed' with its fire time.
//   fire()     at the fire time: one atomic armed -> submitting transition, then broadcast. Nothing else.
//
// Every return value carries an `outcome` from ./outcomes (arm() may also return an ARM.* value).
const { Wallet, Transaction } = require('ethers');
const { getCustodialPrivateKeyAsync } = require('./custodialWallets');
const { resolveAndBuild, routerCheck, storedSpec } = require('./prepareMint');
const { OUTCOME, classifyRevert, notActiveStart, revertLabel, classifyPreparationError, classifyBroadcastError, remainingFromMessage } = require('./outcomes');
const { gasLimitFor, gasCap } = require('./gasPolicy');
const { feeFields, txFeeFields } = require('./feePolicy');
const { fireAtMs, clockLagMs } = require('./launchTiming');
const { automationBlocker, hasSigningKey } = require('./automationPolicy');
const { formatWei } = require('../util/format');
const { readMintedOut } = require('./supply');
const { getOpenSeaDrop } = require('./openSeaDrops');
const { OPEN_ATTEMPT_STATUSES } = require('../db');

const NONCE_CONSUMED_CONFIRM_SEC = 60;

/** Results only arm() produces; the launch engine acts on them, the worker never sees them. */
const ARM = Object.freeze({
  ARMED: 'armed',             // signed and persisted; broadcast at fireAtMs
  OPEN_NOW: 'open-now',       // the mint is already open: send directly now
  NOT_ARMABLE: 'not-armable', // the transaction cannot be built before the opening (API/provider data, dry run)
  EXISTING: 'existing'        // an attempt is already open for this schedule
});

function result(outcome, userReason, extra = {}) { return { outcome, userReason, ...extra }; }
function launchTarget(schedule) { return schedule.trigger_mode === 'launch' ? (schedule.launch_at ?? schedule.scheduled_at) : schedule.scheduled_at; }
function isRevertError(e) { return e?.code === 'CALL_EXCEPTION' || typeof e?.data === 'string'; }
function errText(e) { return String(e?.shortMessage || e?.message || e?.code || 'error').slice(0, 300); }
/** Adapters whose transaction comes from a rate-limited HTTP API at send time: never probe them in a loop. */
function usesSendTimeApi(schedule) {
  const spec = storedSpec(schedule);
  return Boolean(spec && typeof spec === 'object' && spec.adapter === 'opensea-drop');
}

function createFastExecution({
  rpc, db, cfg, chains, log = console, now = null, nowMs = null,
  signerFactory = (privateKey) => new Wallet(privateKey), resolve = resolveAndBuild
}) {
  const automation = cfg.automation;
  const clockMs = nowMs || (now ? () => now() * 1000 : () => Date.now());
  const nowSec = now || (() => Math.floor(clockMs() / 1000));

  function isAvailable() { return Boolean(db && automation.enabled === true && automation.encryptionKey); }

  /** Null when this deployment can auto-sign this schedule's chain and value, else the reason. */
  function scheduleBlocker({ chain, totalWei }) {
    if (!db) return 'Execution database is unavailable.';
    return automationBlocker(cfg, chains, chain, totalWei);
  }
  function isAllowed(schedule) { return scheduleBlocker({ chain: schedule.chain, totalWei: schedule.total_wei }) === null; }

  const walletRow = (schedule) => db.prepare('SELECT * FROM wallets WHERE telegram_id=? AND lower(address)=lower(?)').get(String(schedule.telegram_id), String(schedule.wallet_address));
  const openAttempt = (scheduleId) => db.prepare(`SELECT * FROM execution_attempts WHERE schedule_id=? AND status IN ${OPEN_ATTEMPT_STATUSES} ORDER BY id DESC LIMIT 1`).get(scheduleId);

  function insertAttempt(schedule, { hash, nonce, raw, status = 'submitting', mode = 'direct', fireAt = null, firedAt = null }) {
    const t = nowSec();
    try {
      const r = db.prepare(`INSERT INTO execution_attempts (schedule_id, chain, wallet_address, status, tx_hash, nonce, raw_tx, mode, launch_at, fire_at_ms, fired_at_ms, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(schedule.id, schedule.chain, String(schedule.wallet_address).toLowerCase(), status, hash, Number(nonce), raw,
        mode, launchTarget(schedule), fireAt == null ? null : Math.round(fireAt), firedAt == null ? null : Math.round(firedAt), t, t);
      return db.prepare('SELECT * FROM execution_attempts WHERE id=?').get(Number(r.lastInsertRowid));
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) return null; // another worker holds an open attempt
      throw e;
    }
  }

  function updateAttempt(id, status, error = null) {
    const t = nowSec();
    const resolved = status === 'failed' || status === 'reconciled' ? t : null;
    db.prepare('UPDATE execution_attempts SET status=?, error=?, updated_at=?, resolved_at=COALESCE(?, resolved_at) WHERE id=?').run(status, error, t, resolved, id);
  }

  function markSubmitted(id) {
    db.prepare("UPDATE execution_attempts SET status='submitted', error=NULL, acked_at_ms=COALESCE(acked_at_ms, ?), updated_at=? WHERE id=? AND status IN ('submitting','uncertain')")
      .run(Math.round(clockMs()), nowSec(), id);
  }

  /** Common gates; null when the schedule may be signed, else a TERMINAL result. Returns the wallet row. */
  function gate(schedule) {
    const blocked = scheduleBlocker({ chain: schedule.chain, totalWei: schedule.total_wei });
    if (blocked) return { stop: result(OUTCOME.TERMINAL, blocked) };
    const row = walletRow(schedule);
    if (!row) return { stop: result(OUTCOME.TERMINAL, 'The scheduled wallet no longer belongs to this account.') };
    if (!hasSigningKey(row)) return { stop: result(OUTCOME.TERMINAL, 'The scheduled wallet has no signing key, so MintPilot cannot sign for it.') };
    return { row };
  }

  /**
   * Every read a send needs, in parallel (ethers batches them into one HTTP round trip per endpoint).
   * The SeaDrop router check runs alongside instead of before the simulation.
   */
  async function readState(schedule, spec, tx) {
    const chain = chains[schedule.chain];
    const tipOverridden = cfg.fees?.priorityFeeGwei?.[chain.key] !== undefined;
    const value = BigInt(tx.valueWei);
    const [router, simulation, estimate, balance, fees, nonce] = await Promise.allSettled([
      routerCheck(rpc, schedule, spec, tx, { trustedRouters: cfg.openSeaTrustedRouters, mode: cfg.openSeaRouterCheck }),
      rpc.simulate(schedule.chain, tx),
      rpc.estimateGas(schedule.chain, { from: schedule.wallet_address, to: tx.to, data: tx.data, value }),
      rpc.getBalance(schedule.chain, schedule.wallet_address),
      rpc.getFeeInputs(schedule.chain, { suggestTip: chain.ordering !== 'fcfs' && !tipOverridden }),
      rpc.getNonce(schedule.chain, schedule.wallet_address, 'pending')
    ]);
    return { router, simulation, estimate, balance, fees, nonce, value };
  }

  /** Shared classification of readState; returns { stop } or the usable values. */
  function interpret(schedule, state, { chainTime: chainTimeOpt = null, armed = false } = {}) {
    if (state.router.status === 'rejected') return { stop: classifyPreparationError(state.router.reason) };
    if (state.simulation.status === 'rejected') return { stop: result(OUTCOME.RETRY, 'RPC unavailable during the mint simulation.') };
    const simulation = state.simulation.value;
    if (simulation && simulation.retryable) return { stop: result(OUTCOME.RETRY, 'RPC unavailable during the mint simulation.') };
    if (state.balance.status === 'rejected' || state.fees.status === 'rejected' || state.nonce.status === 'rejected') {
      log.warn?.('wallet state read failed', { scheduleId: schedule.id });
      return { stop: result(OUTCOME.RETRY, 'RPC unavailable while reading the wallet state.') };
    }
    const feeInputs = state.fees.value;
    const chainTime = chainTimeOpt ?? feeInputs.timestamp ?? nowSec();
    const timing = { chainTime, launchAt: launchTarget(schedule), graceSec: cfg.launch.graceSec };
    if (simulation && !simulation.ok) {
      const outcome = classifyRevert(simulation.data, timing);
      const retryAt = notActiveStart(simulation.data, chainTime); // SeaDrop names the exact stage start
      if (!armed || outcome === OUTCOME.TERMINAL) {
        return { stop: result(outcome, outcome === OUTCOME.WAIT ? `Mint not open yet (${revertLabel(simulation.data, 'simulation reverted')}).` : `The contract rejected the mint: ${revertLabel(simulation.data, simulation.reason)}.`, { retryAt: retryAt || undefined, timing: true }) };
      }
      return { closed: true, chainTime, chainStart: retryAt, feeInputs, balance: BigInt(state.balance.value), nonce: Number(state.nonce.value) };
    }
    if (state.estimate.status === 'rejected') {
      const e = state.estimate.reason;
      if (isRevertError(e)) {
        const outcome = classifyRevert(e.data, timing);
        if (!armed || outcome === OUTCOME.TERMINAL) return { stop: result(outcome, outcome === OUTCOME.WAIT ? 'Mint not open yet (gas estimation reverted).' : `The contract rejected the mint: ${revertLabel(e.data, e.shortMessage || e.message)}.`, { timing: true }) };
        return { closed: true, chainTime, chainStart: null, feeInputs, balance: BigInt(state.balance.value), nonce: Number(state.nonce.value) };
      }
      return { stop: result(OUTCOME.RETRY, 'RPC unavailable while estimating gas.') };
    }
    return { open: true, chainTime, estimate: BigInt(state.estimate.value), feeInputs, balance: BigInt(state.balance.value), nonce: Number(state.nonce.value) };
  }

  function fundsCheck(balance, value, gasLimit, fees) {
    if (balance < value) return result(OUTCOME.WAIT, `Wallet balance ${formatWei(balance)} ETH is below the mint value ${formatWei(value)} ETH. Top up the wallet before the deadline.`, { notify: 'funds' });
    const reserve = gasLimit * fees.maxCost;
    if (balance < value + reserve) return result(OUTCOME.WAIT, `Wallet balance ${formatWei(balance)} ETH does not cover the mint value plus up to ${formatWei(reserve)} ETH gas.`, { notify: 'funds' });
    return null;
  }

  /** Decrypt and sign with every field explicit, so signing makes no RPC call. */
  async function sign(schedule, row, fields, assertLock) {
    let signer;
    try { signer = signerFactory((await getCustodialPrivateKeyAsync(row, cfg)).privateKey); }
    catch { return { stop: result(OUTCOME.TERMINAL, 'The wallet signing key could not be decrypted. The operator must check AUTOMATION_MASTER_KEY.') }; }
    if (String(signer.address).toLowerCase() !== String(schedule.wallet_address).toLowerCase()) return { stop: result(OUTCOME.TERMINAL, 'The decrypted signing key does not match the scheduled wallet.') };
    if (!assertLock()) return { stop: result(OUTCOME.LEASE_LOST, null) };
    const request = { ...fields, chainId: BigInt(chains[schedule.chain].chainId) };
    const signed = await signer.signTransaction(request);
    return { signed, hash: Transaction.from(signed).hash };
  }

  /** Broadcast an attempt's signed bytes everywhere and record the result. */
  async function send(attempt, schedule) {
    try {
      const sent = await rpc.broadcast(schedule.chain, attempt.raw_tx);
      markSubmitted(attempt.id);
      log.info?.('mint broadcast accepted', { scheduleId: schedule.id, txHash: attempt.tx_hash, mode: attempt.mode, ackMs: sent?.ackMs, endpoint: sent?.host });
      return result(OUTCOME.SUBMITTED, null, { txHash: attempt.tx_hash, ackMs: sent?.ackMs ?? null });
    } catch (e) {
      const rejected = classifyBroadcastError(e);
      if (rejected?.nonceUsed) {
        // "nonce too low" may be our own transaction, already mined via another endpoint.
        let seen;
        try { seen = await rpc.getTransaction(schedule.chain, attempt.tx_hash); }
        catch {
          updateAttempt(attempt.id, 'uncertain', 'nonce reported used; own hash not checked yet');
          return result(OUTCOME.UNCERTAIN, 'Checking whether the signed transaction was already mined.', { txHash: attempt.tx_hash });
        }
        if (seen) { markSubmitted(attempt.id); return result(OUTCOME.SUBMITTED, null, { txHash: attempt.tx_hash }); }
      }
      if (rejected) {
        updateAttempt(attempt.id, 'failed', String(e?.code || rejected.userReason).slice(0, 300));
        return rejected;
      }
      updateAttempt(attempt.id, 'uncertain', errText(e));
      log.error?.('broadcast outcome uncertain', { scheduleId: schedule.id, txHash: attempt.tx_hash });
      return result(OUTCOME.UNCERTAIN, 'The broadcast result is unknown. MintPilot will look the signed transaction up by hash and will not sign a second one meanwhile.', { txHash: attempt.tx_hash });
    }
  }

  /**
   * Resolve an attempt that was signed but whose broadcast result is unknown.
   * Reads the nonce BEFORE looking the hash up, so "nonce consumed and hash unknown" cannot be a
   * transaction that was mined between the two reads. That state must also persist for
   * NONCE_CONSUMED_CONFIRM_SEC across two passes before the attempt is released for a new signature.
   */
  async function reconcile(attempt, { deadline }) {
    const t = nowSec();
    if (attempt.status === 'submitted' && attempt.tx_hash) return result(OUTCOME.SUBMITTED, null, { txHash: attempt.tx_hash, reconciled: true });
    if (!attempt.tx_hash) {
      // Legacy attempt from before hashes were persisted: its outcome cannot be determined automatically.
      updateAttempt(attempt.id, 'failed', 'legacy attempt without a transaction hash');
      return result(OUTCOME.TERMINAL, 'An earlier automatic submission has an unknown outcome. Check the wallet on the block explorer before minting again.');
    }
    let latestNonce = null;
    try {
      if (attempt.nonce != null) latestNonce = await rpc.getNonce(attempt.chain, attempt.wallet_address, 'latest');
      const seen = await rpc.getTransaction(attempt.chain, attempt.tx_hash);
      if (seen) {
        markSubmitted(attempt.id);
        return result(OUTCOME.SUBMITTED, null, { txHash: attempt.tx_hash, reconciled: true });
      }
    } catch {
      return result(OUTCOME.UNCERTAIN, 'Waiting for the RPC to confirm whether the signed transaction was broadcast.', { txHash: attempt.tx_hash });
    }
    if (latestNonce != null && latestNonce > Number(attempt.nonce)) {
      if (attempt.error === 'nonce-consumed' && t - Number(attempt.updated_at) >= NONCE_CONSUMED_CONFIRM_SEC) {
        updateAttempt(attempt.id, 'failed', 'nonce consumed by a different transaction');
        return result(OUTCOME.RETRY, 'The signed transaction was never mined and its nonce was used by another transaction; MintPilot will sign a new one.');
      }
      if (attempt.error !== 'nonce-consumed') db.prepare("UPDATE execution_attempts SET error='nonce-consumed', updated_at=? WHERE id=?").run(t, attempt.id);
      return result(OUTCOME.UNCERTAIN, 'Confirming whether the signed transaction was replaced.', { txHash: attempt.tx_hash });
    }
    if (deadline != null && t > deadline) {
      updateAttempt(attempt.id, 'failed', 'not seen on-chain before the schedule deadline');
      return result(OUTCOME.TERMINAL, 'The signed transaction was not seen on-chain before the schedule deadline.');
    }
    // Same signed bytes, same hash: re-broadcasting can never create a second transaction.
    if (attempt.raw_tx) {
      try {
        await rpc.broadcast(attempt.chain, attempt.raw_tx);
        // A node accepted the identical transaction: same state as a first-time successful broadcast.
        markSubmitted(attempt.id);
        return result(OUTCOME.SUBMITTED, null, { txHash: attempt.tx_hash, reconciled: true });
      } catch (e) {
        const rejected = classifyBroadcastError(e);
        if (rejected && !rejected.nonceUsed) { updateAttempt(attempt.id, 'failed', String(e?.code || rejected.userReason).slice(0, 300)); return rejected; }
        // "nonce too low" here is handled by the nonce comparison on the next pass; anything else is ambiguous.
      }
    }
    return result(OUTCOME.UNCERTAIN, 'The signed transaction is not visible yet; MintPilot will check again by hash.', { txHash: attempt.tx_hash });
  }

  /**
   * Broadcast a pre-signed (armed) attempt. The armed -> submitting transition is one UPDATE that also
   * requires the schedule to be active, so a cancel or expiry that wins the race means nothing is sent.
   */
  async function fire(attempt, schedule, { assertLock = () => true } = {}) {
    const firedAt = clockMs();
    if (firedAt + 5 < Number(attempt.fire_at_ms)) return result(OUTCOME.WAIT, 'The pre-signed mint is waiting for its fire time.', { armed: true, fireAtMs: Number(attempt.fire_at_ms), retryAt: Math.ceil(Number(attempt.fire_at_ms) / 1000) });
    if (!assertLock()) return result(OUTCOME.LEASE_LOST, null);
    const claimed = db.prepare(`UPDATE execution_attempts SET status='submitting', fired_at_ms=?, updated_at=? WHERE id=? AND status='armed'
      AND EXISTS (SELECT 1 FROM schedules s WHERE s.id=execution_attempts.schedule_id AND s.status IN ('scheduled','ready'))`).run(Math.round(firedAt), nowSec(), attempt.id).changes === 1;
    if (!claimed) return result(OUTCOME.LEASE_LOST, 'The pre-signed mint was cancelled, expired or already sent.');
    const sent = await send({ ...attempt, status: 'submitting', fired_at_ms: firedAt }, schedule);
    // The armed limit is the configured cap; if the node refuses it, sign again from a live estimate.
    if (sent.outcome === OUTCOME.TERMINAL && sent.gasLimitRejected) return result(OUTCOME.RETRY, 'The pre-signed gas limit was refused; re-signing from a fresh estimate.', { immediate: true });
    return sent;
  }

  async function execute(schedule, { assertLock = () => true, chainTime = null, deadline = null, reducedOnce = false } = {}) {
    if (!db) return result(OUTCOME.TERMINAL, 'Execution database is unavailable.');
    const existing = openAttempt(schedule.id);
    if (existing) {
      if (existing.status === 'armed') return fire(existing, schedule, { assertLock });
      return reconcile(existing, { deadline });
    }
    const { stop, row } = gate(schedule);
    if (stop) return stop;

    let built;
    try { built = await resolve(schedule, { rpc, cfg, now: nowSec(), checkRouter: false }); }
    catch (e) {
      log.warn?.('mint preparation failed', { scheduleId: schedule.id, error: e?.message });
      const classified = classifyPreparationError(e);
      // OpenSea says the drop is not minting: tell "sold out" apart from "not open yet" instead of waiting silently.
      if (e?.name === 'OpenSeaApiError' && classified.outcome === OUTCOME.WAIT && classified.apiCost && classified.notify !== 'funds') {
        const out = await readMintedOut(rpc, schedule.chain, schedule.contract);
        if (out) return result(OUTCOME.TERMINAL, `This collection is minted out (${out.minted} / ${out.max}). There is nothing left to mint, so MintPilot stopped this schedule.`);
        return { ...classified, inactive: true };
      }
      // Fewer are left than were asked for (supply or this wallet's limit): mint what is left instead of nothing.
      if (e?.name === 'OpenSeaApiError' && !reducedOnce) {
        const left = remainingFromMessage(e.message);
        const spec = storedSpec(schedule);
        const asked = Number(spec?.quantity ?? schedule.quantity);
        if (spec && typeof spec === 'object' && spec.adapter === 'opensea-drop' && left != null && left >= 1 && left < asked) {
          const total = String(BigInt(spec.priceWei ?? schedule.price_wei ?? 0) * BigInt(left));
          const reduced = { ...schedule, quantity: left, total_wei: total, mint_spec: JSON.stringify({ ...spec, quantity: left }) };
          try { db.prepare('UPDATE schedules SET quantity=?, total_wei=?, mint_spec=? WHERE id=?').run(left, total, reduced.mint_spec, schedule.id); }
          catch (err) { log.warn?.('could not save the reduced quantity', { scheduleId: schedule.id, error: err?.message }); }
          const again = await execute(reduced, { assertLock, chainTime, deadline, reducedOnce: true });
          return { ...again, reducedFrom: asked, reducedTo: left };
        }
      }
      // "Limit reached" and "minted out" arrive as one OpenSea message: a supply read says which one it is.
      if (classified.limitOrSoldOut) {
        const out = await readMintedOut(rpc, schedule.chain, schedule.contract);
        if (out) return result(OUTCOME.TERMINAL, `This collection is minted out (${out.minted} / ${out.max}). There is nothing left to mint, so MintPilot stopped this schedule.`);
      }
      return classified;
    }
    const { spec, tx } = built;
    const view = interpret(schedule, await readState(schedule, spec, tx), { chainTime });
    if (view.stop) return view.stop;

    const policy = gasLimitFor(cfg, view.estimate, tx.quantity, schedule.chain);
    if (!policy.ok) return result(OUTCOME.TERMINAL, `Estimated gas ${policy.estimate} exceeds the cap ${policy.cap} for ${tx.quantity} token(s). Raise GAS_CAP_BASE/GAS_CAP_PER_TOKEN (or GAS_CAP_JSON for this chain) only after checking the contract.`);
    let fees;
    try { fees = feeFields(chains[schedule.chain], cfg, view.feeInputs); }
    catch { return result(OUTCOME.RETRY, 'Fee data unavailable; retrying.'); }
    const value = BigInt(tx.valueWei);
    const short = fundsCheck(view.balance, value, policy.gasLimit, fees);
    if (short) return short;

    if (automation.dryRun) {
      return result(OUTCOME.DRY_RUN, `Dry run passed: would send ${formatWei(value)} ETH to ${tx.to} with gas limit ${policy.gasLimit}. Nothing was signed or sent.`, { gasLimit: policy.gasLimit.toString() });
    }

    let signedTx;
    try {
      signedTx = await sign(schedule, row, { to: tx.to, data: tx.data, value, gasLimit: policy.gasLimit, nonce: view.nonce, ...txFeeFields(fees) }, assertLock);
    } catch (e) {
      return result(OUTCOME.RETRY, `Could not sign the transaction (${errText(e)}); retrying.`);
    }
    if (signedTx.stop) return signedTx.stop;

    // Persist BEFORE broadcasting: after a crash the hash and the exact signed bytes are still known.
    const attempt = insertAttempt(schedule, { hash: signedTx.hash, nonce: view.nonce, raw: signedTx.signed, firedAt: clockMs() });
    if (!attempt) return result(OUTCOME.UNCERTAIN, 'Another worker opened a submission for this schedule.');
    if (!assertLock()) { updateAttempt(attempt.id, 'failed', 'wallet lease lost before broadcast'); return result(OUTCOME.LEASE_LOST, null); }
    return send(attempt, schedule);
  }

  /**
   * Prepare and pre-sign a launch mint, to be broadcast by fire() at the returned fireAtMs.
   * The gas limit is the configured cap: the estimate reverts while the stage is closed, and EIP-1559
   * charges gas used, not the limit. If the cap is ever too low the transaction reverts out of gas and
   * the launch engine re-signs at once from an estimate (the stage is open by then).
   */
  async function arm(schedule, { assertLock = () => true, offsetMs = cfg.launch.fireOffsetMs } = {}) {
    if (!db) return result(OUTCOME.TERMINAL, 'Execution database is unavailable.');
    const existing = openAttempt(schedule.id);
    if (existing) return result(ARM.EXISTING, null, { attempt: existing });
    const { stop, row } = gate(schedule);
    if (stop) return stop;
    if (automation.dryRun) return result(ARM.NOT_ARMABLE, 'Dry run: nothing is pre-signed.');
    if (usesSendTimeApi(schedule)) return result(ARM.NOT_ARMABLE, 'The transaction comes from the OpenSea API once the stage is live.');

    let built;
    try { built = await resolve(schedule, { rpc, cfg, now: nowSec(), checkRouter: false }); }
    catch (e) {
      const c = classifyPreparationError(e);
      return c.outcome === OUTCOME.TERMINAL ? c : result(ARM.NOT_ARMABLE, c.userReason, { cause: c });
    }
    const { spec, tx } = built;
    const view = interpret(schedule, await readState(schedule, spec, tx), { armed: true });
    if (view.stop) return view.stop;
    if (view.open) return result(ARM.OPEN_NOW, null, { chainTime: view.chainTime });

    let gasLimit = gasCap(cfg, tx.quantity, schedule.chain);
    let fees;
    try { fees = feeFields(chains[schedule.chain], cfg, view.feeInputs, cfg.launch.armedFeeMultiplierBps); }
    catch { return result(OUTCOME.RETRY, 'Fee data unavailable; retrying.'); }
    const value = BigInt(tx.valueWei);
    const short = fundsCheck(view.balance, value, gasLimit, fees);
    if (short) return short;

    const lagMs = clockLagMs(view.chainTime, clockMs());
    if (lagMs) log.warn?.('server clock is behind the chain; fire time corrected', { scheduleId: schedule.id, lagMs });
    const fireAt = fireAtMs({ launchAtSec: launchTarget(schedule), chainStartSec: view.chainStart, triggerMode: schedule.trigger_mode, offsetMs, lagMs });
    if (fireAt - clockMs() > (cfg.launch.armSec + 5) * 1000) {
      // SeaDrop reports a later stage start than the schedule: arm again closer to it.
      return result(OUTCOME.WAIT, 'The stage opens later than scheduled; MintPilot will arm closer to its start.', { retryAt: Math.floor(fireAt / 1000) - cfg.launch.armSec, chainStart: view.chainStart });
    }

    let signedTx;
    try {
      signedTx = await sign(schedule, row, { to: tx.to, data: tx.data, value, gasLimit, nonce: view.nonce, ...txFeeFields(fees) }, assertLock);
    } catch (e) {
      return result(OUTCOME.RETRY, `Could not sign the transaction (${errText(e)}); retrying.`);
    }
    if (signedTx.stop) return signedTx.stop;
    const attempt = insertAttempt(schedule, { hash: signedTx.hash, nonce: view.nonce, raw: signedTx.signed, status: 'armed', mode: 'armed', fireAt });
    if (!attempt) return result(ARM.EXISTING, null, { attempt: openAttempt(schedule.id) });
    log.info?.('mint armed', { scheduleId: schedule.id, txHash: signedTx.hash, fireAtMs: Math.round(fireAt), lagMs, chainStart: view.chainStart, gasLimit: gasLimit.toString() });
    return result(ARM.ARMED, null, { attempt, fireAtMs: fireAt, lagMs, chainStart: view.chainStart });
  }

  // Probes reuse a recent build for a few seconds so provider-backed specs (proofs, signatures) are not
  // fetched from the operator's provider on every 250 ms probe. execute() always resolves fresh data.
  const PROBE_BUILD_TTL_MS = 10_000;
  const probeBuilds = new Map();

  /**
   * Cheapest "is it open yet?" check for the launch engine's fast loop: build (local for on-chain
   * adapters) + one eth_call. Returns { open: true } or an outcome to act on.
   */
  async function probe(schedule) {
    let built = probeBuilds.get(schedule.id);
    if (!built || clockMs() - built.at > PROBE_BUILD_TTL_MS) {
      try { built = { ...(await resolve(schedule, { rpc, cfg, now: nowSec(), checkRouter: false })), at: clockMs() }; }
      catch (e) { probeBuilds.delete(schedule.id); return classifyPreparationError(e); }
      probeBuilds.set(schedule.id, built);
      if (probeBuilds.size > 1000) probeBuilds.delete(probeBuilds.keys().next().value);
    }
    let simulation;
    try { simulation = await rpc.simulate(schedule.chain, built.tx); }
    catch { return result(OUTCOME.RETRY, 'RPC unavailable during the mint simulation.'); }
    if (simulation.ok) { probeBuilds.delete(schedule.id); return { open: true }; }
    if (simulation.retryable) return result(OUTCOME.RETRY, 'RPC unavailable during the mint simulation.');
    const chainTime = nowSec();
    const outcome = classifyRevert(simulation.data, { chainTime, launchAt: launchTarget(schedule), graceSec: cfg.launch.graceSec });
    const retryAt = notActiveStart(simulation.data, chainTime);
    return result(outcome, outcome === OUTCOME.WAIT ? `Mint not open yet (${revertLabel(simulation.data, 'simulation reverted')}).` : `The contract rejected the mint: ${revertLabel(simulation.data, simulation.reason)}.`, { retryAt: retryAt || undefined, timing: true });
  }

  // One cheap OpenSea read answers "is this drop's stage live?" for every schedule watching the same drop,
  // so waiting for a late opening does not spend the mint-request quota. true = mint now, false = still closed,
  // null = cannot tell (the caller then falls back to the normal retry pacing).
  const dropWatch = new Map();
  async function probeOpenSea(schedule) {
    let slug = null;
    try { slug = JSON.parse(schedule.mint_spec || 'null')?.slug || null; } catch { slug = null; }
    if (!slug || !cfg.openSeaApiKey) return null;
    const t = Date.now();
    for (const [k, v] of dropWatch) if (t - v.at > 60_000) dropWatch.delete(k);
    const hit = dropWatch.get(slug);
    if (hit && t - hit.at < 1500) return hit.value;
    let value = null;
    try {
      const drop = await getOpenSeaDrop(slug, { cfg });
      if (drop && (drop.is_minting === true || drop.active_stage)) value = true;
      else if (drop && drop.is_minting === false) value = false;
    } catch { value = null; }
    dropWatch.set(slug, { at: t, value });
    return value;
  }

  return { execute, arm, fire, probe, probeOpenSea, reconcile, isAvailable, isAllowed, scheduleBlocker, usesSendTimeApi, openAttempt };
}

module.exports = { createFastExecution, launchTarget, usesSendTimeApi, ARM };
