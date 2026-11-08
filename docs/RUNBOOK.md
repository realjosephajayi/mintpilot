# MintPilot — Operations runbook

All queries are read-only unless marked **write**. Run them against a backup first:
```js
// one-off: node -e "<this>"   (Node ≥ 22.13)
const { DatabaseSync } = require('node:sqlite');
new DatabaseSync('/app/data/bot.sqlite').exec("VACUUM INTO '/app/data/backup-YYYY-MM-DD.sqlite'");
```

## Launch-day checklist
1. Logs show `Automation: enabled=true dryRun=false chains=<includes the launch chain> masterKey=set` and
   no `Config:` warnings.
2. `npm run check:rpc` passes (it checks every chain in parallel and flags public default RPCs);
   authenticated RPCs configured (and fallbacks in `RPC_FALLBACK_URLS_JSON`).
   `GET /readyz` answers 200.
3. For each launch schedule, the owner ran `/preflight <id>`: all checks ✅ except the expected
   "not active yet" simulation before the opening.
4. Wallets funded with mint value **plus gas reserve** (`/preflight` shows the reserve).
5. Gas caps calibrated for this chain (`GAS_CAP_BASE`, `GAS_CAP_PER_TOKEN`, or `GAS_CAP_JSON` for it),
   especially on Robinhood Chain and Arbitrum One. A chain is offered publicly only after a canary mint.
6. OpenSea drops: confirm the key's quota (`X-RateLimit-*` headers) covers one write per wallet plus retries.
7. Logs show `Launch engine: on arm=60s fireOffset=50ms …`. The server clock is NTP-synced
   (`date -u` matches a time source to well under a second).
8. **No redeploys or restarts in the `AUTOMATION_WALLET_LOCK_TTL_SECONDS` (120 s) before a launch**: a dead
   worker's wallet lease must expire before another can fire. Armed mints survive a restart and fire with
   their original bytes.
9. About a minute before the opening each user gets "🎯 … pre-signed and armed. It will be sent at …".
   A schedule without it is not armed: check `/preflight` and the logs (`mint armed`, funds notices).

## Launch timing report
```sql
SELECT a.id, a.mode, a.status, a.nonce, a.launch_at,
       a.fired_at_ms - a.fire_at_ms AS fire_delay_ms,      -- timer precision
       a.acked_at_ms - a.fired_at_ms AS ack_ms,            -- first endpoint acknowledgement
       a.included_at - a.launch_at  AS landed_after_s,     -- 0 = the opening second
       a.included_block, a.gas_used, a.error, s.chain_retries
FROM execution_attempts a JOIN schedules s ON s.id = a.schedule_id
WHERE a.schedule_id = ? ORDER BY a.id;
```
Logs carry the same as `mint armed`, `mint broadcast accepted` and `mint landed`. Tune with evidence:
* `landed_after_s` > 0 with `fire_delay_ms` ≈ 0 and small `ack_ms`: the RPC or its distance to the
  sequencer is the bottleneck; use a closer/faster endpoint.
* Frequent first-attempt reverts (`error = 'reverted on-chain'`, then a retry): fire offset too early for
  this server's clock; raise `LAUNCH_FIRE_OFFSET_MS` by 50–100 ms.
* `gas_used` close to `GAS_CAP_BASE` on a chain: raise the cap (pre-signed mints use the cap as their limit).
* `error` mentioning the gas limit on armed mints: the cap is below the chain's intrinsic cost
  (Arbitrum-style chains add the parent-chain data cost); raise it.

## What a schedule is doing
```sql
SELECT id, status, trigger_mode, datetime(launch_at,'unixepoch') launch, datetime(end_at,'unixepoch') ends,
       attempts, datetime(next_attempt_at,'unixepoch') next_try, last_error
FROM schedules WHERE id = ?;
SELECT id, status, tx_hash, nonce, error, datetime(updated_at,'unixepoch') updated
FROM execution_attempts WHERE schedule_id = ? ORDER BY id;
```
`last_error` is the latest user-facing status (e.g. "Mint not open yet", "Wallet balance … is below …").

## Armed attempts
An `armed` attempt is signed but NOT sent; it fires at `fire_at_ms`. `/cancel` in the bot (or the cancel
query below) cancels it safely: the fire step only sends while the schedule is active.

## Uncertain attempts
An attempt in `submitting`/`uncertain` **has a tx_hash**: look it up on the explorer.
* Visible → the worker records it on its next pass (no action).
* Not visible → the worker re-sends the identical bytes every 30 s until the schedule deadline; it never
  signs a different transaction while the attempt is open.
* Nonce used by another transaction for ≥ 60 s → the worker releases the attempt and may sign again.
Do **not** cancel or expire such schedules by hand unless the explorer proves the hash was never mined and
the wallet nonce has moved past `nonce`.

Legacy attempts from before v2.1 have no hash; the worker fails them with an "unknown outcome" message.
Check the wallet's history on the explorer before re-scheduling.

## Stuck or noisy schedules
```sql
-- Active schedules past their deadline but held by an open attempt
SELECT s.id, s.status, a.status attempt, a.tx_hash FROM schedules s
JOIN execution_attempts a ON a.schedule_id = s.id AND a.status IN ('submitting','uncertain','submitted')
WHERE s.status IN ('scheduled','ready');
-- Schedules backing off hard (retries)
SELECT id, attempts, last_error FROM schedules WHERE status='scheduled' AND attempts >= 6;
```
**write** — cancel a schedule with no open attempt:
`UPDATE schedules SET status='cancelled' WHERE id=? AND status IN ('scheduled','ready') AND NOT EXISTS (SELECT 1 FROM execution_attempts WHERE schedule_id=schedules.id AND status IN ('submitting','uncertain','submitted'));`

## Monitoring (v2.3)
`GET /metrics` with `Authorization: Bearer $METRICS_TOKEN`. Alert on:

| Metric | Alert when | Meaning |
|---|---|---|
| `mintpilot_execution_attempts_open{status="uncertain"}` | > 0 for 5 min | a signed mint whose broadcast is unknown; see *Uncertain attempts* |
| `mintpilot_worker_last_tick_age_seconds` | > 6 × `WORKER_TICK_MS` | worker stalled: due mints and receipts are not processed |
| `mintpilot_updates_queued` | > 100 for 2 min | bot saturated; raise `BOT_MAX_CONCURRENT_UPDATES` or find the slow handler (`slow update` log lines) |
| `mintpilot_telegram_outbound_queued` | > 500 | fan-out backlog (big launch); messages are delayed, not lost |
| `mintpilot_rpc_endpoint_up` | 0 for a chain with launches today | every endpoint for that chain is quarantined or cooling down |
| `mintpilot_rpc_queued_requests{priority="high"}` | > 0 sustained | launch reads wait for tokens: raise `RPC_RATE_LIMIT_PER_SECOND` to the provider plan |
| `mintpilot_event_loop_delay_ms{quantile="0.99"}` | > 200 | CPU-bound process; split roles or move to a larger instance |
| `mintpilot_inbox_rows` | grows steadily | updates stored but not finishing; check `update failed` logs |

`Telegram 409 Conflict` in the logs means a second process (or a webhook) uses the same bot token: stop it.

## Upgrading from v2.2
* Migration 12 (automatic) adds the `tg_inbox` table. Take a backup first (top of this file).
* **Testnets and the local node are removed.** Delete `ENABLE_TESTNETS`, `SEPOLIA_RPC_URL`,
  `BASE_SEPOLIA_RPC_URL`, `ROBINHOOD_TESTNET_RPC_URL`, `ENABLE_LOCALNET`, `LOCAL_RPC_URL` and
  `AUTOMATION_MAINNET_ENABLED`; they are logged as warnings. Schedules on a testnet chain key (if any) can
  no longer run: `SELECT id, chain, status FROM schedules WHERE chain IN ('sepolia','base-sepolia','robinhood-testnet','localhost') AND status IN ('scheduled','ready')`
  and cancel them (**write**: `UPDATE schedules SET status='cancelled' WHERE id IN (...)`).
* **Signing switch:** `AUTOMATION_ENABLED` + `AUTOMATION_DRY_RUN` + `AUTOMATION_ALLOWED_CHAINS`. An explicit
  `AUTOMATION_MAINNET_ENABLED=false` with live signing on refuses to start (so the removal cannot turn
  signing on by surprise).
* **New chains** (Arbitrum One, OP Mainnet, Zora, Shape, Unichain, Soneium) are in the registry and, when
  `AUTOMATION_ALLOWED_CHAINS` is unset, allowlisted. Set `<KEY>_RPC_URL` for each one you enable.
* OpenSea REST now runs on Robinhood Chain (`robinhood` identifier) and every new chain.
* Behind a Cloudflare tunnel set `CLIENT_IP_HEADER=cf-connecting-ip` (otherwise all web users share one
  rate-limit bucket). Point the platform health check at `/readyz`.
* Rollback: v2.2 code opens a v2.3 database (it ignores `tg_inbox`). Unfinished inbox rows are not replayed
  by v2.2; drain first (SIGTERM and wait for `Shutdown complete.`).

## Upgrading from v2.1
* Migration 11 (automatic) rebuilds `execution_attempts` to allow status `armed` and adds timing columns,
  and adds `schedules.chain_retries`. Existing attempts are kept; take a backup first (top of this file).
* New defaults: the launch engine is on, the worker tick is 5 s (was 15 s), the tip is 0 on Robinhood
  Chain. Review the "Launch engine" and "Fees" blocks of `.env.example`.
* A mint that reverts on-chain is now re-signed (up to `LAUNCH_MAX_CHAIN_RETRIES`) instead of failing.
* Roll back behaviour with `LAUNCH_ENGINE=false` (tick-only, v2.1 timing). Rolling back the code to v2.1
  also works (it opens a migrated database and leaves the new columns alone), but v2.1 does not know
  `armed` attempts: a schedule with one would be blocked by the one-open-attempt index. Before a code
  rollback, let armed launches fire or cancel them
  (`SELECT schedule_id FROM execution_attempts WHERE status='armed'`).

## Upgrading from v2.0
* Migration adds `schedules.next_attempt_at/attempts/last_error` and `execution_attempts.nonce/raw_tx`
  (automatic on start).
* Schedules in status `ready` were waiting for a manual signing link, which no longer exists; they expire at
  their deadline. Ask users to re-create them.
* Wallets linked by signature only (no key) cannot be scheduled; their pending schedules fail with
  "no signing key".
* Launch schedules without an opening time use their creation time; re-create generic-contract launch
  schedules so the wizard records the opening time.
* Move `SEADROP_SIGNATURE_PROVIDERS_JSON` to `ELIGIBILITY_PROVIDERS_JSON` (add `"kind":"seadrop-signed"`);
  the old variable still works.
* Specs that used `proofFile`/`proofUrl`/`signatureFile`/`signatureUrl` now fail with a clear message;
  configure a provider instead.
* Set `AUTOMATION_*` explicitly in the deployment: the image no longer sets them.

## Secrets
| Secret | Rotate freely? | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | BotFather `/revoke`, update the variable, restart. Rotate it if it was ever inside a zip, chat or repository; build releases with `npm run release`, which refuses it |
| `METRICS_TOKEN` | Yes | |
| `OPENSEA_API_KEY` | Yes | |
| RPC provider keys | Yes | They stay on the server since v2.1; rotate any that were configured before v2.1 (the old mint page sent the RPC URL to browsers) |
| Provider headers in `ELIGIBILITY_PROVIDERS_JSON` | Yes | |
| `AUTOMATION_MASTER_KEY` | **No** | Every wallet key is sealed with it. Rotation requires decrypting with the old key and re-sealing every `wallets` row with the new one in a maintenance window. Back it up. |
