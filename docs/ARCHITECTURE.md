# MintPilot — Architecture

Telegram application that **schedules NFT mints and signs them automatically** on ten EVM mainnets
(Ethereum, Base, Ink, Robinhood Chain, Arbitrum One, OP Mainnet, Zora, Shape, Unichain, Soneium) from
encrypted custodial wallets, with transaction tracking, Free/Premium plans (Telegram Stars) and referrals.
Mainnets only: there is no testnet or local-node mode at runtime (ADR-0006).

## 1. Key design decision: automatic custodial signing only

Users never sign mint transactions. Every wallet MintPilot can mint from holds a signing key encrypted at
rest with `AUTOMATION_MASTER_KEY` (AES-256-GCM, per-wallet scrypt-derived key):

* **Platform wallet** — generated for every user on first contact.
* **Imported/created wallets** (Premium) — created or imported on the HTTPS `/import` page. The browser
  proves control (challenge signature) and sends the key, which is validated against the address and sealed.

There is no non-custodial or browser-signing path: the old `/connect`, `/mint` and `/authorize` pages and
the smart-account/delegation subsystem were removed (ADR-0004). A schedule is only accepted when the
deployment can auto-sign it: automation enabled, master key present, chain allowlisted, value under
`AUTOMATION_MAX_VALUE_ETH`, and a wallet with a signing key.

| Step | Who | Where |
|---|---|---|
| Create schedule | User | Telegram wizard (refused up front if it cannot be auto-signed) |
| Arm before the opening (pre-sign) | Launch engine, custodial key | `launchEngine.js` → `fastExecution.arm` |
| Fire at T + offset (ms timer) | Launch engine | `fastExecution.fire` → `rpc.broadcast` (all endpoints) |
| Retry bad timing within ms | Launch engine (probe, receipt watch, re-sign) | `launchEngine.js` |
| Late / slow-path schedules | Worker tick (`WORKER_TICK_MS`, 5 s) gated by the chain timestamp | `worker.js` |
| Prepare + simulate the exact tx | Executor | `prepareMint.js` |
| Sign → persist → broadcast | Executor, custodial key | `fastExecution.js` |
| Track confirmation, report token IDs | Worker (read-only RPC) | `worker.js` |

## 2. Components

```
                ┌──────────────────── one Node.js process (or split with --roles) ───────────────────┐
 Telegram ◄────►│ bot/poller (durable inbox, per-chat queues) ─► bot/handlers (commands, wizard)     │
                │ telegram (outbound pacer: global + per-chat buckets, 429 pause)                   │
                │                    │                                                             │
 Browser  ◄────►│ web/server: /import · /dashboard · /healthz · /readyz · /metrics (bearer)          │
                │                    │                                                             │
                │ worker (tick) ─► launchEngine ─► fastExecution ─► prepareMint ─► providers / OpenSea│
                │   │                 │                 │                                          │
                │   │                 │                 └► mintAdapters ─► mintTx (calldata)       │
                │   │                 └► outcomes · gasPolicy · feePolicy · launchTiming · sign     │
                │   └► schedules (deadlines, backoff) · tracking · referrals                        │
                │       core/rpc (chain-id verified, 8 s timeouts, priority lanes, failover reads,  │
                │                 parallel unthrottled broadcast) · abiSources · adapters/thirdweb  │
                └────────────────────────────────────────────────────────────────────────────────────┘
```

* `src/chains.js` — mainnet registry: id, RPC, explorer, Blockscout ABI API, confirmations, stack,
  ordering, OpenSea identifier. Tests inject their own local chain.
* `src/core/automationPolicy.js` — the one gate (enabled, key, chain allowlist, value cap), used at
  schedule creation and before signing.
* `src/bot/poller.js` — getUpdates → `tg_inbox` + offset in one transaction → per-chat FIFO queues,
  `BOT_MAX_CONCURRENT_UPDATES` chats in parallel, pre-checkout bypass, replay after restart, 409 back-off.
* `src/core/abiSources.js` — verified ABI from Blockscout → Sourcify → Etherscan V2, bounded and cached.
* `src/core/adapters/thirdweb.js` — first self-contained adapter module: calldata, phase reader, phase
  blockers, revert classification, key allowlists (the target shape for every adapter, docs/HANDOFF.md).
* `src/core/health.js` — readiness checks and Prometheus metrics; no user data.
* `src/core/prepareMint.js` — the single *resolve → build → SeaDrop router check → simulate* path used by
  the executor, `/ready` and `/preflight`.
* `src/core/outcomes.js` — outcome vocabulary; SeaDrop custom-error decoding; OpenSea `code` and node
  broadcast-error classification; backoff.
* `src/core/fastExecution.js` — custodial executor: `execute` (direct send), `arm` (pre-sign), `fire`
  (broadcast an armed attempt), `probe` (one `eth_call`), reconciler.
* `src/launchEngine.js` — per-schedule launch sessions: arm, warm, fire on a millisecond timer, fast
  retries, receipt watch and immediate re-sign after an on-chain revert (ADR-0005).
* `src/core/feePolicy.js` — explicit EIP-1559 fields; tip 0 on first-come-first-served chains.
* `src/core/launchTiming.js` — fire time, clock-lag correction, landing delta.
* `src/core/mintAdapters.js` + `mintTx.js` — allowlisted mint shapes and per-adapter key allowlists;
  calldata bound to the scheduled contract, wallet and quantity.
* `src/core/eligibilityProviders.js` — operator-configured providers (hardened fetch) and the OpenSea
  resolver.
* `src/telegram.js` — small fetch client (no Telegram library) with the outbound pacer.
* `src/core/custodialWallets.js` — AES-256-GCM sealing; scrypt runs on the thread pool, derived keys are
  cached per wallet (`sealAsync`, `getCustodialPrivateKeyAsync`, single-flight platform provisioning).

## 3. Flows

**Schedule** — wizard: network (only chains that can be auto-signed) → contract (bytecode must exist;
discovery reads ERC-165, proxies, SeaDrop routers) → mint method (preset, SeaDrop public, adapter JSON with
an allowlisted key set, or OpenSea slug) → quantity/price → trigger (time, or "when the mint opens" with the
opening time from the drop or the user) → wallet(s) with signing keys (inline proofs/signatures: exactly
one wallet) → confirm.

**Execute** (per due schedule, under a per-wallet SQLite lease):
1. If an execution attempt is open: an `armed` one is fired (below); any other is reconciled.
2. Gate (automationPolicy) and wallet key present.
3. Resolve fresh provider/OpenSea data and build the calldata.
4. In parallel: router check, `eth_call`, gas estimate, balance, latest block (base fee + chain time), nonce.
5. Revert → `classifyRevert`: SeaDrop `NotActive` waits (next attempt aimed at the stage start), other
   decoded SeaDrop errors stop; unknown reverts wait only until opening + `LAUNCH_GRACE_SECONDS`.
6. Gas policy (`estimate × 1.25`, cap by quantity), fee policy, balance vs value + reserve.
7. Dry run → report and stop.
8. Sign with explicit nonce/fees/limit/chain id (no RPC) → hash; **persist hash, nonce and raw bytes**;
   re-check the lease; broadcast to every endpoint at once. Node rejections (`INSUFFICIENT_FUNDS`,
   `REPLACEMENT_UNDERPRICED`, fee below base fee, gas limit refused) close the attempt as failed;
   `NONCE_EXPIRED` does too, but only after our own hash is confirmed absent; anything else is `uncertain`.

**Launch** (launch engine, one session per schedule in `[T − arm, T + hot window]`, holding the wallet
lease throughout):
1. `arm`: steps 2–6 ahead of time; a closed stage is expected (simulation reverts, no estimate); sign with
   the gas cap and armed fee headroom; persist as `armed` with `fire_at_ms`. SeaDrop `NotActive` gives the
   real stage start; launch mode adopts it (`launch_at` updated).
2. Warm all endpoints at fire − 1.5 s; at `fire_at_ms` one UPDATE moves `armed → submitting` only while the
   schedule is active (so cancel/expiry win cleanly), then broadcast.
3. Follow-up: receipt polled every `LAUNCH_RECEIPT_POLL_MS`. Reverted → `settleReceipt` re-queues the
   schedule (`chain_retries + 1`) and the session re-signs at once; closed stage → `probe` every
   `LAUNCH_RETRY_INTERVAL_MS`, full send when it passes; transient errors retry within 2 s. After the hot
   window, or for funds/API waits, the schedule returns to the tick.
4. Restart: an `armed` attempt is recovered and fired with its original bytes; never re-signed.

**Reconcile** — read the wallet nonce, then look the hash up. Seen → submitted. Not seen and nonce still
free → re-send the identical raw bytes (same hash; accepted → submitted). Not seen and nonce consumed for
≥ 60 s across two passes → the attempt is released and a new signature is allowed. Past the schedule
deadline → failed with a message.

**Worker outcome handling** (tick path and engine hand-offs) — `submitted` records the tracked tx; `wait` polls every tick (or sleeps until
the decoded stage start); `retry` and OpenSea waits back off exponentially (persisted `next_attempt_at`,
`attempts`); `terminal` fails once with a message; `uncertain` re-checks in 30 s; `dry-run` completes as
`ready`. Each notice is sent at most once per schedule and kind (`reminders_sent`). Schedules expire at
`end_at`, or start/opening + `LAUNCH_MAX_WAIT_SECONDS`, unless a signed attempt is still open.

**Track** — pending txs are polled (each tick; every 200 ms by the engine for launch mints); after the
chain's confirmations the receipt's ERC-721 `Transfer` and ERC-1155 `TransferSingle/Batch` logs give the
token IDs. One shared `settleReceipt` (atomic claim on the tracked row) handles both callers; a reverted
scheduled mint is re-queued while `LAUNCH_MAX_CHAIN_RETRIES` and the deadline allow. Unseen after 24 h ⇒
`dropped`. The referee's first confirmed scheduled mint pays the referral reward.

**Premium** — Telegram Stars (`XTR`) invoice; premium granted only from `successful_payment`, idempotent by
charge id.

## 4. Plans

| | Free | Premium |
|---|---|---|
| Active schedules | 3 | 30 |
| Wallets | 1 (platform) | 5 (platform + 4) |
| Pending tracked txs | 5 | 50 |
| Alerts | result messages | + 10 min and 1 min before a timed mint |

## 5. Data model (SQLite, migrations via `PRAGMA user_version`)

`users` · `wallets` (address UNIQUE, encrypted key) · `web_sessions` · `schedules` (trigger_mode,
launch_at, end_at, next_attempt_at, attempts, last_error, **chain_retries**) · `execution_attempts` (status
incl. **`armed`**, tx_hash, nonce, raw_tx, **mode, launch_at, fire_at_ms, fired_at_ms, acked_at_ms,
included_block, included_at, gas_used**; one open attempt per schedule) · `wallet_execution_locks` · `reminders_sent`
(PK schedule+kind ⇒ at-most-once notices) · `tracked_txs` · `payments` (charge_id UNIQUE) · `referrals` ·
`conversations` · `kv`. Smart-account tables from earlier versions remain for data compatibility and are
unused.

## 6. Threat model

| Threat | Mitigation |
|---|---|
| Master key or DB theft | Keys sealed with AES-256-GCM under a per-wallet scrypt key derived from `AUTOMATION_MASTER_KEY`; the master key lives only in the deployment secret store, never in the image |
| User makes the server read files / call URLs (SSRF) | Adapter JSON has a per-adapter key allowlist; file/URL keys are rejected; eligibility data only from operator providers |
| Hostile or broken provider | HTTPS only, redirects refused, 64 KB cap, 5 s timeout, bindings to wallet/contract/chain/quantity, no body or URL in user messages |
| Calldata injection / drain | No free-form calldata; allowlisted selectors; SeaDrop `nftContract` bound to the schedule; router must be NFT-authorized on every SeaDrop route; OpenSea payload bound and value-capped; exact simulation; per-tx value cap |
| Double mint after a crash or ambiguous send | Hash, nonce and raw bytes persisted before broadcast; one open attempt per schedule; reconcile by hash; only identical bytes are re-sent; parallel broadcast sends identical bytes; "nonce too low" is trusted only after our hash is confirmed absent; an on-chain re-sign happens only after a mined revert (no mint occurred) |
| Pre-signed mint fired after a cancel | `armed → submitting` is one UPDATE conditioned on the schedule being active; cancel/expiry mark the armed attempt failed in the same transaction |
| Gas griefing | Gas limit from the estimate with a quantity-scaled cap |
| Wrong network / hostile RPC | Chain id verified per endpoint; signed tx carries the registry chain id |
| RPC credential exposure | RPC URLs never sent to browsers (no browser signing page) |
| Phishing via our pages | Strict CSP (`connect-src 'self'`), no inline JS, `frame-ancestors 'none'`, `no-referrer`, DOM via `textContent` |
| Link theft / replay | 192-bit single-use expiring sessions |
| Rate-limit evasion | Client IP from the last trusted proxy hop (`TRUST_PROXY_HOPS`) or a configured edge header (`CLIENT_IP_HEADER`, e.g. `cf-connecting-ip`) |
| Secrets in a release archive | `npm run release` builds from git/allowlist and refuses `.env*`, databases, keys, logs and committed tokens; CI runs the same gate |
| One user degrading everyone | Per-chat queues with a global concurrency cap; per-user flood limit; RPC timeouts and priority lanes; paced outbound messages |
| Metrics leaking data | `/metrics` is off without `METRICS_TOKEN`, bearer-checked in constant time, and carries counts only |
| Shared OpenSea quota exhaustion | Terminal codes stop at once; waits back off; `/ready`/`/preflight` throttled per schedule |
| Accidental live deploy | Docker image has no signing defaults; config defaults are off/dry-run; startup log states the mode |
| Double premium / reminders | DB idempotency (charge id UNIQUE, reminder PK) |
| Info leaks | Only `UserError`/sanitized messages reach chat; internals are logged |

## 7. Known limits

* **Custodial.** Users trust the operator with keys; disclose it and limit balances.
* **Not a guaranteed win.** Launch mints are pre-signed and fired on a millisecond timer, but RPC latency to
  the sequencer, other buyers, supply and outages still decide. The fire time depends on an NTP-synced
  server clock; a clock that runs ahead is only caught by the cheap revert + immediate re-sign.
* **One nonce stream per wallet.** A launch session holds the wallet lease from arming until it settles;
  a second schedule on the same wallet at the same moment waits for it.
* **Restart latency.** A crashed worker's lease is free only after `AUTOMATION_WALLET_LOCK_TTL_SECONDS`
  (default 120 s); avoid redeploying in the minutes before a launch.
* **Pre-signed bytes live in the database until the fire time.** The key itself is not kept: arming
  decrypts, signs and discards it; `fire` only sends stored bytes; a re-sign decrypts again. A signed
  mint in the DB is a sendable transaction, so DB theft before T could let an attacker broadcast it early
  (it would revert while the stage is closed, or mint to the user's own wallet), never redirect funds.
* **Supported mint shapes only.** Presets, SeaDrop public/signed, common Merkle/signature shapes, token
  gates, OpenSea REST ERC-721 SeaDrop V1, thirdweb Drop ERC-721/ERC-1155 public native-ETH phases.
  ERC-20-priced mints, allowlist phases without a provider, Manifold, Zora, Magic Eden and others need new
  adapters (`docs/HANDOFF.md`).
* **ETH-gas chains only.** Caps are ETH-denominated; non-ETH chains need per-chain caps first (HANDOFF).
* **Single machine.** SQLite; exactly one bot poller and one worker per database. Horizontal scaling
  needs a shared datastore and distributed leases (HANDOFF).
* **Gas caps need calibration** per chain from canary mints (`GAS_CAP_JSON`), especially Arbitrum/Orbit.
* ERC-1271 verification on the import page uses `ERC1271_CHAIN`; undeployed (ERC-6492) wallets are not
  supported.
