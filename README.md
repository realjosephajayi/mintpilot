# MintPilot — Telegram NFT Mint Scheduler (automatic signing)

Telegram bot that schedules NFT mints and **signs and sends them automatically** from encrypted
custodial wallets on **ten EVM mainnets**: Ethereum, Base, Ink, Robinhood Chain, Arbitrum One, OP Mainnet,
Zora, Shape, Unichain and Soneium. It tracks transactions and offers Free/Premium plans (Telegram Stars) and
referral links. JavaScript/Node.js, ethers v6, Hardhat, Solidity.

**Mainnets only.** There is no testnet or local-node mode at runtime (v2.3.0 removed them); rollout safety
comes from dry-run mode, the per-chain allowlist and value caps. What is not built yet, and how to build it,
is in **docs/HANDOFF.md**.

> Read **docs/ARCHITECTURE.md** first. Every wallet MintPilot mints from is custodial: its signing key is
> encrypted with `AUTOMATION_MASTER_KEY`. There is no manual signing page; users never sign mint
> transactions themselves. Deposit only funds you are prepared to risk.

## Requirements
* Node.js **≥ 22.13** (uses built-in `node:sqlite`; Node prints an "experimental" warning — expected)
* A bot token from [@BotFather](https://t.me/BotFather)
* A public **HTTPS** URL for the wallet import page and dashboard (Telegram URL buttons need https)

## Quick start
```bash
npm install
cp .env.example .env        # set TELEGRAM_BOT_TOKEN, PUBLIC_URL, ADMIN_TELEGRAM_IDS, AUTOMATION_MASTER_KEY
npm run check:rpc           # verifies each RPC really serves the expected chain id
npm test                    # lint + unit tests (node:test) + contract tests (Hardhat)
npm start                   # bot + web + worker in one process
```
Generate the master key with `openssl rand -hex 32` and back it up: changing it makes every encrypted
wallet key unreadable. Split roles if you like: `npm run bot`, `npm run web`, `npm run worker` (one bot
poller per token).

On startup the log states the signing mode, chains, launch and scale settings, e.g.
`Automation: enabled=true dryRun=true chains=base,robinhood masterKey=set perTxCap=0.2 ETH`.
Removed settings (`ENABLE_TESTNETS`, `*_SEPOLIA_RPC_URL`, `AUTOMATION_MAINNET_ENABLED`, …) are reported as
`Config:` warnings. When automatic signing is unavailable, new schedules are refused with the reason.

## Rollout on mainnet (no testnets)
1. **Dry run.** Paid RPCs, `AUTOMATION_ENABLED=true`, `AUTOMATION_DRY_RUN=true`, one chain in
   `AUTOMATION_ALLOWED_CHAINS`, a small `AUTOMATION_MAX_VALUE_ETH`. Schedule a real, cheap or free mint:
   at the opening you get a *Dry run passed: would send …* report and nothing is signed. Run `/preflight`
   against the real collection.
2. **Canary.** `AUTOMATION_DRY_RUN=false` with `AUTOMATION_MAX_VALUE_ETH` near the canary's price and a
   wallet holding only what the canary needs. Mint one free or low-cost NFT per chain you intend to offer;
   record the *Landed …* line and `execution_attempts.gas_used` (calibrate `GAS_CAP_JSON` from it).
3. **Public.** Add chains to `AUTOMATION_ALLOWED_CHAINS` one at a time, each after its canary, and raise
   value caps only as live metrics support it (`docs/RUNBOOK.md`).

`AUTOMATION_MAINNET_ENABLED` no longer exists. An old `AUTOMATION_MAINNET_ENABLED=false` together with live
signing (`AUTOMATION_ENABLED=true`, `AUTOMATION_DRY_RUN=false`) stops the process at startup instead of being
ignored, so removing testnets can never switch signing on by surprise.

## Networks (mainnets)
| Key | Chain ID | Stack / ordering | Default RPC (rate limited) | Verified-ABI source | OpenSea id |
|---|---|---|---|---|---|
| `ethereum` | 1 | Ethereum / fee | ethereum-rpc.publicnode.com | eth.blockscout.com | `ethereum` |
| `base` | 8453 | OP Stack / fee | mainnet.base.org | base.blockscout.com | `base` |
| `ink` | 57073 | OP Stack / fee | rpc-gel.inkonchain.com | explorer.inkonchain.com | `ink` |
| `robinhood` | 4663 | Arbitrum Orbit / FCFS | rpc.mainnet.chain.robinhood.com | robinhoodchain.blockscout.com | `robinhood` |
| `arbitrum` | 42161 | Arbitrum / FCFS | arb1.arbitrum.io/rpc | arbitrum.blockscout.com | `arbitrum` |
| `optimism` | 10 | OP Stack / fee | mainnet.optimism.io | optimism.blockscout.com | `optimism` |
| `zora` | 7777777 | OP Stack / fee | rpc.zora.energy | explorer.zora.energy | `zora` |
| `shape` | 360 | OP Stack / fee | mainnet.shape.network | shapescan.xyz | `shape` |
| `unichain` | 130 | OP Stack / fee | mainnet.unichain.org | unichain.blockscout.com | `unichain` |
| `soneium` | 1868 | OP Stack / fee | rpc.soneium.org | soneium.blockscout.com | `soneium` |

Every chain uses ETH for gas and payment, so the ETH-denominated caps mean the same thing everywhere.
Each chain's RPC comes from `<KEY>_RPC_URL` (e.g. `ARBITRUM_RPC_URL`) with fallbacks in
`RPC_FALLBACK_URLS_JSON`; `AUTOMATION_ALLOWED_CHAINS` (default: all) decides where signing is on. The
public default RPCs are rate limited: production needs a provider endpoint per enabled chain. Chain ids,
RPCs and OpenSea identifiers were checked against official docs, viem and the opensea-js `Chain` enum (Nov
2026). Adding a chain, including non-ETH chains, is described in docs/HANDOFF.md.

Verified ABIs (used only to *narrow* the offered mint methods) come from the chain's Blockscout instance,
then Sourcify, then Etherscan V2 when `ETHERSCAN_API_KEY` is set. Lookups are cached and shared, so a
crowd scheduling one drop costs one explorer request.

### Serving many users at once
* **Inbound:** Telegram updates are written to a durable inbox (`tg_inbox`) before the offset advances,
  then handled concurrently: different chats in parallel (`BOT_MAX_CONCURRENT_UPDATES`, default 32), each
  chat strictly in order. A slow command for one user never delays another. Payment pre-checkout queries
  skip the queues (10 s deadline). A crash or deploy replays unfinished updates.
* **Outbound:** every message is paced under Telegram's limits (`TELEGRAM_GLOBAL_PER_SECOND`, per-chat
  burst then ~1/s), chats are served round-robin, and a 429 pauses all sends for `retry_after`.
* **RPC:** hard per-request timeout (`RPC_TIMEOUT_MS`, default 8 s) with ethers' hidden retries disabled;
  per-endpoint rate limiting with priority lanes: launch sessions first, user commands next, receipt polling
  last. `/wallets` queries every network in parallel.
* **CPU:** wallet-key derivation (scrypt) runs on the libuv thread pool and is cached per wallet, so arming
  many wallets never freezes the bot.
* **Operations:** `/healthz` (liveness), `/readyz` (database, Telegram poll, worker tick, event-loop lag),
  `/metrics` (Prometheus, `METRICS_TOKEN` bearer), graceful SIGTERM drain (`SHUTDOWN_DRAIN_SECONDS`).
* **Limits:** one process runs the bot and worker roles per database (SQLite). Horizontal scaling needs the
  shared datastore described in docs/HANDOFF.md.

### RPC resilience
`RPC_FALLBACK_URLS_JSON` adds up to eight HTTPS endpoints per chain. Every endpoint is checked against the
configured chain ID before use. Reads fail over on transient transport/timeout/rate-limit errors;
deterministic reverts do not. Requests are paced per endpoint (`RPC_RATE_LIMIT_PER_SECOND`,
`RPC_RATE_LIMIT_BURST`) and failing endpoints cool down (`RPC_FAILURE_COOLDOWN_MS`). RPC URLs never leave
the server.

Signed transactions are sent to **every** configured endpoint at once, on separate connections that never
batch and are never held back by the read rate limiter; the first acceptance wins. Identical signed bytes
have one hash, so this cannot create a second transaction. For launches, configure a low-latency paid
endpoint for the chain plus at least one fallback, and raise `RPC_RATE_LIMIT_PER_SECOND` to what that
provider allows.

## How automatic execution works
Each send runs the same steps (`src/core/fastExecution.js`):
1. reconcile any earlier signed attempt by its hash (never sign a second one meanwhile);
2. check the deployment gate (enabled, chain allowlisted, mainnet flag, value cap) and the wallet key;
3. resolve live eligibility data and build the calldata;
4. in **one parallel round trip**: check the SeaDrop router (SeaDrop routes), **simulate the exact
   transaction**, estimate gas, read the balance, the latest block (base fee and chain clock) and the nonce;
5. apply the gas and fee policy and check the balance covers value plus gas;
6. in dry-run mode stop here and report; otherwise **sign locally with every field explicit (no RPC call),
   store the hash, nonce and raw signed bytes, then broadcast to every endpoint at once**.

### Launch engine — how a launch mint is made fast
Schedules inside `[T − LAUNCH_ARM_SECONDS, T + LAUNCH_HOT_WINDOW_SECONDS]` (T = opening time) are run by
the launch engine (`src/launchEngine.js`, `docs/adr/0005-launch-engine.md`), not by the worker tick:
1. **Arm** (default 60 s before T): steps 1–5 run ahead of time. The stage is still closed, so the
   simulation reverts as expected and the estimate is unavailable; the transaction is signed with the gas
   cap as its limit (EIP-1559 charges gas *used*), fee headroom over the current base fee
   (`LAUNCH_ARMED_FEE_MULTIPLIER_BPS`, default ×3) and **no tip on first-come-first-served chains
   (Robinhood)**, then stored as `armed` with its fire time. The user gets one "🎯 armed" message.
2. **Fire**: 1.5 s before T every RPC connection is warmed; at **T + `LAUNCH_FIRE_OFFSET_MS`** (default
   50 ms, server clock) a millisecond timer broadcasts the pre-signed bytes. Nothing else runs at T.
3. **Bad timing → immediate retry**: the receipt is polled every `LAUNCH_RECEIPT_POLL_MS` (200 ms). If the
   mint reverted on-chain (the block was before the opening, or the cap was too low), the schedule is
   re-queued and **re-signed with a fresh nonce at once**, from a live estimate; while the stage is still
   closed MintPilot probes it with one `eth_call` every `LAUNCH_RETRY_INTERVAL_MS` (250 ms) and sends the
   moment it passes. At most `LAUNCH_MAX_CHAIN_RETRIES` (3) on-chain re-signs per schedule; decoded
   failures (sold out, wallet limit, invalid proof…) stop without spending gas.
4. Transient RPC errors inside the hot window retry within 250 ms–2 s instead of waiting for a tick; a
   base fee above the signed cap or a refused gas limit is re-signed immediately.

Mints that cannot be pre-signed (the OpenSea REST adapter, whose transaction exists only once the stage is
live; dry-run mode) are built and sent directly at the fire time. After the hot window, and for waits that
are not about timing (wallet funds, OpenSea back-off), the schedule returns to the worker tick
(`WORKER_TICK_MS`, default 5 s). `LAUNCH_ENGINE=false` restores tick-only behaviour.

Every result is one of `submitted`, `wait`, `retry`, `terminal`, `uncertain`, `dry-run` (see
`docs/adr/0002-execution-outcomes.md`):
* **wait** — the mint is not open yet or the wallet needs funds. Retried every tick; a SeaDrop
  `NotActive` revert names the stage start, so the next attempt is aimed exactly at it. One "top up"
  message is sent when funds are short.
* **retry** — RPC/provider/OpenSea transient errors. Exponential backoff (0, 0, 0, 0, 30, 60, 120, 240,
  300 s…), honouring `Retry-After`. OpenSea "not minting" waits back off too, because each attempt spends a
  shared API write.
* **terminal** — cannot succeed as configured (sold out, not eligible, wrong recipient, gas over the cap…).
  The schedule fails once with a message.
* **uncertain** — signed but the broadcast result is unknown. Re-checked by hash every 30 s; the identical
  signed bytes may be re-sent (same hash, so it can never create a second transaction).

A schedule stops at its deadline: the mint-window end, or its start/opening time +
`LAUNCH_MAX_WAIT_SECONDS` (default 6 h), with one "expired" message showing the last status.

### Mint timing
* **Choose a time** — MintPilot pre-signs and sends at that time (never earlier, even if the stage opens
  earlier).
* **When the mint opens** — for SeaDrop public drops and OpenSea drops the opening time comes from the
  drop; for any other contract the wizard asks for it. When SeaDrop's `NotActive` revert names a different
  stage start, the schedule follows the chain. After the opening a reverting simulation is treated as "not
  open yet" for `LAUNCH_GRACE_SECONDS` (default 120 s), after which an unexplained revert is final. Decoded
  SeaDrop reverts are classified exactly (`NotActive` waits; sold out, wallet limit, invalid
  proof/signature… stop).

The fire time uses the server clock (keep it NTP-synced; containers on Railway are). A block timestamp more
than a second ahead of the server clock proves the server is behind and the fire time is corrected; a
server clock running ahead cannot be detected that way and costs at most one cheap revert and an
immediate re-sign. On a first-come-first-served chain such as Robinhood Chain position is decided by
arrival at the sequencer, so RPC latency to the sequencer is what remains: use a low-latency endpoint
close to it. The contract remains the final authority; supply, other buyers and RPC outages can still
cause a miss.

Every confirmed launch mint reports where it landed ("⏱ Landed in the opening second" / "Ns after the
opening"); the attempt row records the fire time, the actual send time, the node acknowledgement time,
the inclusion block and timestamp and the gas used (`docs/RUNBOOK.md`).

### Gas policy
`gasLimit = estimate × GAS_ESTIMATE_MULTIPLIER_BPS / 10000` (default ×1.25), refused when the estimate
exceeds `GAS_CAP_BASE + GAS_CAP_PER_TOKEN × (quantity − 1)` (defaults 300 000 + 100 000 per extra token).
Calibrate the caps from real mainnet canary mints, especially on Arbitrum One and Orbit chains such as
Robinhood Chain, whose estimates include the parent-chain data cost: override per chain with
`GAS_CAP_JSON`, e.g. `{"arbitrum":{"base":800000,"perToken":120000}}`. Pre-signed launch mints use the cap itself as their
limit; `execution_attempts.gas_used` records real usage per mint for calibration.

### Fee policy
`maxFeePerGas = ceil(baseFee × FEE_BASE_MULTIPLIER_BPS / 10000) + tip` (default ×2; pre-signed mints use
`LAUNCH_ARMED_FEE_MULTIPLIER_BPS`, default ×3). EIP-1559 charges the actual base fee, so the multiplier is
headroom, not cost; it raises only the balance the wallet must hold. The tip is 0 on
first-come-first-served chains (Robinhood Chain, Arbitrum One: a tip does not change ordering), the RPC's
`eth_maxPriorityFeePerGas` suggestion elsewhere, and `PRIORITY_FEE_GWEI_JSON` (e.g. `{"base":"0.05"}`)
overrides either per chain.

## Commands
The Telegram menu shows six: `/start` `/schedule` `/mints` `/wallets` `/dashboard` `/help`.
The menu buttons are **Schedule a mint**, **My mints**, **Wallets**, **Dashboard** and **Plan**. Plan holds the
plan details, the Premium upgrade button and the invite link; **My mints** has Check and Cancel buttons on each open mint.
Older names still work as hidden shortcuts: `/myschedules` (same as `/mints`), `/wallet`, `/plans`, `/premium`, `/referral`,
`/ready <scheduleId>`, `/preflight <scheduleId>`, `/check <walletAddress>`, `/track <network> <hash>` and `/cancel`.
Admin (IDs in `ADMIN_TELEGRAM_IDS`): `/grant <id> <days>` `/revoke <id>` `/stats`.

Every user gets a **platform wallet** at `/start`. Premium users can create or import up to four more
wallets on the HTTPS `/import` page; the key is encrypted at rest. A wallet without a signing key cannot be
scheduled.

## Mint methods
* **Presets** — `mint()`, `mint(quantity)`, `publicMint(quantity)` (filtered by the verified ABI when one is
  available).
* **SeaDrop public** — detected automatically; price, window, wallet cap and fee rules come from chain.
* **SeaDrop signed** — via an operator `seadrop-signed` provider; the live `mintPrice` becomes the stored
  spend ceiling (`docs/SEADROP_PROVIDER_SETUP.md`).
* **Merkle / signature-gated** — allowlisted function shapes; proof/signature inline (valid for one wallet)
  or from an operator `merkle`/`signature` provider (fetched fresh per wallet).
* **Token-gated** — allowlisted mint function plus a read-only ERC-20/721/1155 balance check.
* **OpenSea REST (ERC-721 SeaDrop V1)** — see below.
* **thirdweb Drop (ERC-721 and ERC-1155)** — detected from the contract (multi-phase and single-phase
  claim conditions). The wizard lists the phases with their on-chain start, price and wallet limit; a
  public, native-ETH phase is scheduled at its exact price with the launch time read from the contract.
  ERC-1155 drops ask for the token ID. Allowlist phases and ERC-20-priced phases are shown but refused
  (they need a proof provider / token approvals). If the creator changes the price, the contract rejects the
  claim and the schedule stops; MintPilot never pays a different price.

The adapter JSON accepts **only** the fields each adapter documents (unknown fields are rejected). File
paths and URLs are never accepted from users.

### Eligibility providers
Configure `ELIGIBILITY_PROVIDERS_JSON` (see `.env.example`). Each provider has a `kind`
(`merkle`/`signature`/`seadrop-signed`), an HTTPS `url`, optional `method`, secret `headers` and optional
`chain`/`contract` restrictions. MintPilot sends the wallet, chain, contract and quantity (query string for
GET, JSON body for POST) and rejects answers bound to another wallet, contract, chain or quantity. Redirects
are refused, responses are capped at 64 KB, and only a generic status reaches users. Return 429/5xx for
"try later" and 4xx for "not eligible".

### OpenSea REST SeaDrop V1 mint builder
Set `OPENSEA_API_KEY` on the server. The wizard validates the collection with `GET /api/v2/drops/{slug}` and
the executor requests a fresh transaction from `POST /api/v2/drops/{slug}/mint` immediately before
simulation. The response chain must match the network's OpenSea identifier (column above; unmapped chains
are refused), the calldata must be a recognized SeaDrop V1 mint bound to the NFT, wallet and quantity, the
value must not exceed your ceiling, and the router must be in the NFT's allowed-SeaDrop list.

Errors are handled by OpenSea's stable `code`: `NOT_MINTING` waits (with backoff), `INSUFFICIENT_BALANCE`
waits with a top-up message, `MINTER_NOT_ELIGIBLE`/`MINT_LIMIT_EXCEEDED`/`SUPPLY_EXHAUSTED`/
`NO_PAYOUT_ADDRESS`/`UNSUPPORTED_DROP_TYPE`/`DROP_NOT_FOUND` stop the schedule, 429/5xx retry. `/ready` and
`/preflight` on an OpenSea schedule are limited to one per minute per schedule because each spends a write.
All users share the key's quota (OpenSea's free-key example shows 30 writes/hour); get a full key and a
rate-limit increase before multi-wallet launches. ERC-1155 drops are not supported by this endpoint.

References: [Build drop mint transaction](https://docs.opensea.io/reference/build_drop_mint_transaction),
[Get drop by slug](https://docs.opensea.io/reference/get_drop_by_slug),
[API keys/rate limits](https://docs.opensea.io/reference/api-keys).

### NFT eligibility file
`ELIGIBILITY_FILE` (default `data/eligible-addresses.json`) is an operator-maintained allowlist used by
`/check` and as an advisory line in `/ready`. It does not replace on-chain eligibility.

## Checks
* `/ready <id>` — wallet, contract bytecode, balance, ERC-721 ownership, mint history and the exact
  simulation.
* `/preflight <id>` — 13 read-only launch checks: automatic-signing gate, signing key, RPC chain id and
  latency, live eligibility data, signed phase window, exact transaction, SeaDrop router, balance, gas
  estimate/limit/cap/reserve, exact simulation, nonce, prior submissions (an armed mint is shown with its
  fire time). It never signs or broadcasts.
* `/dashboard` — private, expiring, read-only page with wallets, schedules (incl. last status) and
  transactions.

## Project layout
```
src/index.js               entrypoint (--roles=bot,web,worker)
src/bot/                   Telegram handlers (wizard, payments) + long poller
src/web/                   node:http server + public/ (wallet import portal, dashboard)
src/worker.js              tick: routes launches to the engine; late schedules, alerts, expiry, tracking
src/launchEngine.js        launch sessions: arm, warm, fire on a ms timer, fast retries, receipt watch
src/core/fastExecution.js  custodial executor: execute / arm / fire / probe, sign -> persist -> broadcast
src/core/feePolicy.js      explicit EIP-1559 fields (tip 0 on FCFS chains)
src/core/launchTiming.js   fire time, clock-lag correction, landing delta
src/core/prepareMint.js    the single resolve -> build -> router check -> simulate path
src/core/outcomes.js       outcome vocabulary, SeaDrop revert decoding, OpenSea/broadcast classification
src/core/mintAdapters.js   allowlisted mint shapes, key allowlists, bindings
src/core/adapters/         self-contained protocol adapters (thirdweb.js); target layout in docs/HANDOFF.md
src/core/abiSources.js     verified ABI: Blockscout -> Sourcify -> Etherscan V2, cached
src/core/health.js         /readyz checks and /metrics
src/bot/poller.js          durable inbox + per-chat ordered, concurrent dispatch
src/telegram.js            Bot API client with outbound pacing
scripts/release.js         release archive that refuses .env, databases, keys and committed tokens
src/core/eligibilityProviders.js  operator providers + OpenSea resolver (hardened fetch)
contracts/                 ProjectNFT.sol (test drop), test doubles (incl. ThirdwebDropMock.sol)
test/unit/                 node:test — no network (review-regressions.test.js covers every review finding)
test/unit/launch-engine.test.js  the launch engine on a virtual-clock chain (exact timings)
test/contracts/            Hardhat (local in-process chain only) — contracts, launch engine, thirdweb adapter
test/unit/public-scale.test.js  inbox/poller, pacing, RPC priority, async custody, ABI sources, health, release gate
docs/                      ARCHITECTURE, RUNBOOK, HANDOFF (upgrade plan), REVIEW, ADRs, provider setup
```

## Before you go public — checklist
* [ ] Rotate the bot token if it was ever inside a zip, chat or repository; release with `npm run release`
      (it refuses `.env`, databases, keys and committed tokens)
* [ ] Stable HTTPS `PUBLIC_URL` (not a temporary trycloudflare.com address); `TRUST_PROXY_HOPS` or
      `CLIENT_IP_HEADER` (`cf-connecting-ip` behind a Cloudflare tunnel) set, or every web user shares one
      rate-limit bucket; regular, off-host, restore-tested DB backups
* [ ] Paid RPC providers for every chain in `AUTOMATION_ALLOWED_CHAINS`; `npm run check:rpc` passes;
      `RPC_RATE_LIMIT_PER_SECOND` matches the provider plan
* [ ] `/readyz` wired to the platform health check; `METRICS_TOKEN` set and alerts on uncertain attempts,
      worker tick age, queue depth and RPC endpoints (docs/RUNBOOK.md)
* [ ] `AUTOMATION_MASTER_KEY` generated, stored outside the image and backed up
* [ ] Mainnet rollout above completed per chain (dry run → canary); gas caps calibrated (`GAS_CAP_JSON`)
* [ ] Terms, Privacy Policy and a support contact (Telegram requires this for paid bots); custody disclosed
* [ ] Refund policy (Stars refunds via `refundStarPayment`; not implemented)
* [ ] Security review of `custodialWallets.js`, `fastExecution.js`, `server.js` and any contract you deploy;
      the demo contract is **unaudited**
