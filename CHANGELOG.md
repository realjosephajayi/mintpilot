# Changelog
Format: [Keep a Changelog](https://keepachangelog.com/). Review finding numbers refer to `docs/REVIEW.md`.

## [2.3.0] — 2026-11-05
Mainnet-only, ten chains, built to serve many users at once. ADR-0006. Upgrade notes: `docs/RUNBOOK.md` →
*Upgrading from v2.2*. Not built yet (with the plan and adapter structure): `docs/HANDOFF.md`.

### Removed
- Testnets (`sepolia`, `base-sepolia`, `robinhood-testnet`) and the local Hardhat chain from the runtime
  registry; `ENABLE_TESTNETS`, `*_SEPOLIA_RPC_URL`, `ROBINHOOD_TESTNET_RPC_URL`, `ENABLE_LOCALNET`,
  `LOCAL_RPC_URL`, the Hardhat testnet networks and `scripts/deploy.js`. Tests inject their own local chain.
- `AUTOMATION_MAINNET_ENABLED` (every chain is a mainnet). An explicit `false` together with live signing
  refuses to start rather than being ignored.

### Added
- Chains: Arbitrum One, OP Mainnet, Zora, Shape, Unichain, Soneium (ETH gas; ids, RPCs and OpenSea
  identifiers checked against official docs, viem and the opensea-js `Chain` enum). `<KEY>_RPC_URL` per
  chain; `AUTOMATION_ALLOWED_CHAINS` defaults to all.
- OpenSea REST on Robinhood Chain (`robinhood`) and every new chain.
- thirdweb Drop adapter (ERC-721 and ERC-1155, multi- and single-phase): phases read from the contract,
  exact on-chain price, launch time from the phase start, window closes at the next phase, token ID bound,
  `DropClaimNotStarted` waits / sold out, wallet limit and changed price stop. Allowlist and ERC-20 phases
  are refused with a reason. Verified against the published thirdweb ABI and on a local EVM.
- Verified-ABI discovery on every chain: Blockscout → Sourcify → Etherscan V2 (`ETHERSCAN_API_KEY`), bounded,
  cached and shared between concurrent users (Ethereum and Base never found an ABI before).
- Durable Telegram inbox (migration 12, `tg_inbox`) with per-chat ordered, concurrent dispatch
  (`BOT_MAX_CONCURRENT_UPDATES`), pre-checkout bypass, replay after restart, 409 Conflict back-off, and a
  reply to the user when a handler fails.
- Outbound Telegram pacing (global + per-chat buckets, round-robin, 429 pause) — `TELEGRAM_*` settings.
- RPC: hard timeout (`RPC_TIMEOUT_MS`, default 8 s) with ethers' hidden 429 retries disabled; priority
  lanes (launch > user > polling); `getBalances` (parallel, per-chain failure); parallel `hasOnchainActivity`.
- `/readyz` and `/metrics` (Prometheus, `METRICS_TOKEN`), graceful SIGTERM drain (`SHUTDOWN_DRAIN_SECONDS`),
  `unhandledRejection`/`uncaughtException` handlers, Docker `HEALTHCHECK`, `UV_THREADPOOL_SIZE=8`.
- `CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`) for deployments behind an edge such as a Cloudflare tunnel.
- `GAS_CAP_JSON` per-chain gas caps. `ERC1271_CHAIN` is validated.
- `npm run release` / `release:check`: archives from git or an allowlist and refuses `.env*`, databases,
  keys, logs and committed bot tokens. CI workflow (`.github/workflows/ci.yml`).

### Changed
- Wallet keys: scrypt runs on the thread pool and derived keys are cached per wallet (no event-loop
  blocking when many wallets arm); platform-wallet provisioning is single-flight per user. `/preflight`
  now derives the address from the decrypted key.
- `/wallets` queries every chain in parallel and lists funded networks; `/help` lists the networks.
- Contract discovery runs its reads in parallel; receipt polling runs `TRACKING_CONCURRENCY` lookups at
  the lowest RPC priority; launch sessions run at the highest.
- Limiters are swept; web sockets have header/request/keep-alive timeouts.

## [2.2.0] — 2026-11-04
Launch engine: launch mints are pre-signed and fired on a millisecond timer, and a mint that fails on
timing is re-signed at once (`docs/adr/0005-launch-engine.md`). Prompted by two reference mints from
another bot that landed in the opening second on Robinhood Chain with the same SeaDrop technology.

### Added
- Launch sessions for schedules in `[T − LAUNCH_ARM_SECONDS, T + LAUNCH_HOT_WINDOW_SECONDS]`: arm (every
  check + signature ahead of time, persisted as `armed`), warm RPC connections 1.5 s before, broadcast at
  `T + LAUNCH_FIRE_OFFSET_MS` (default 50 ms). One "🎯 armed" message per schedule.
- Immediate retry after bad timing: receipts polled every 200 ms; an on-chain revert re-queues the schedule
  and re-signs with a fresh nonce at once (`LAUNCH_MAX_CHAIN_RETRIES`, default 3); while the stage is closed
  a one-call probe runs every 250 ms. Transient RPC errors in the hot window retry within 2 s.
- Parallel broadcast: identical signed bytes to every configured endpoint at once, on non-batching
  connections outside the read rate limiter; "already known" counts as accepted.
- Fee policy: explicit EIP-1559 fields; tip 0 on first-come-first-served chains (Robinhood Chain);
  `PRIORITY_FEE_GWEI_JSON` per-chain override; `FEE_BASE_MULTIPLIER_BPS`, `LAUNCH_ARMED_FEE_MULTIPLIER_BPS`.
- Launch mode follows the stage start SeaDrop's `NotActive` reports; a server clock behind the chain by
  more than a second is corrected from block timestamps.
- Landing report: "⏱ Landed in the opening second / Ns after the opening"; attempts record fire, send and
  acknowledgement times, inclusion block and timestamp, and gas used (`docs/RUNBOOK.md` → timing report).
- `/preflight` reports an armed mint and its fire time. Armed mints can be cancelled.
- Settings: `LAUNCH_ENGINE`, `LAUNCH_ARM_SECONDS`, `LAUNCH_FIRE_OFFSET_MS`, `LAUNCH_HOT_WINDOW_SECONDS`,
  `LAUNCH_RETRY_INTERVAL_MS`, `LAUNCH_RECEIPT_POLL_MS`, `LAUNCH_RECEIPT_WATCH_SECONDS`,
  `LAUNCH_MAX_CHAIN_RETRIES`, `LAUNCH_MAX_SESSIONS`, `WORKER_TICK_MS`.

### Changed
- Direct sends read router, simulation, estimate, balance, latest block and nonce in one parallel round trip
  and sign with explicit fields (no `populateTransaction` reads). Read batching stall 10 ms → 1 ms.
- Worker tick 15 s → 5 s (`WORKER_TICK_MS`); launch schedules are no longer polled before their arming
  window (v2.1 read the chain time for every launch schedule on every tick).
- A scheduled mint that reverts on-chain is re-signed (within its window and retry budget) instead of failing.

### Fixed
- "Nonce too low" from one endpoint is no longer treated as "re-sign": the executor first checks whether its
  own transaction is already on-chain (a parallel broadcast on a 100 ms chain can see it mined).
- A broadcast refused for a fee below the base fee re-signs with fresh fees immediately.
- Tracked transactions are settled by one atomic claim, so the tick and a launch session never both act.

### Migration
- 11: `execution_attempts` rebuilt (status `armed`; columns `mode, launch_at, fire_at_ms, fired_at_ms,
  acked_at_ms, included_block, included_at, gas_used`); `schedules.chain_retries`. Automatic; back up first.

## [2.1.0] — 2026-11-04
MintPilot now signs mints **automatically only**, from encrypted custodial wallets.

### Security
- Adapter JSON accepts only each adapter's documented keys; `proofFile`, `signatureFile`, `proofUrl`,
  `signatureUrl` are rejected (file read, SSRF and `/dev/zero` crash from chat) (#1).
- Eligibility data comes only from operator providers in `ELIGIBILITY_PROVIDERS_JSON`
  (`SEADROP_SIGNATURE_PROVIDERS_JSON` still read as kind `seadrop-signed`) (#1).
- Provider and OpenSea requests refuse redirects; provider responses capped at 64 KB; plain-HTTP localhost
  only outside production; provider errors never echo URLs, headers or bodies (#1).
- RPC URLs are no longer sent to browsers (the mint page is gone) (#9). Rotate RPC keys configured before 2.1.
- Rate limiting uses the address added by the last trusted proxy (`TRUST_PROXY_HOPS`) (#14).
- The Docker image no longer enables live mainnet signing; config defaults are off/dry-run (#16).
- Web CSP narrowed to `connect-src 'self'`.

### Fixed
- "When the mint opens" no longer fails on the first pre-launch revert: the opening time is recorded
  (from the drop or the user), SeaDrop `NotActive` waits until the stage start, unknown reverts wait for
  `LAUNCH_GRACE_SECONDS` (#2).
- OpenSea errors are handled by their stable `code`: eligibility/config codes stop once with a message,
  `NOT_MINTING` waits with backoff; `/ready`/`/preflight` throttled per schedule (#3).
- Schedules have deadlines (`end_at`, else start + `LAUNCH_MAX_WAIT_SECONDS`); stuck launch schedules no
  longer retry forever (#3).
- Signed transactions are persisted (hash, nonce, raw) before broadcast; node rejections are failures, not
  "uncertain"; ambiguous sends are reconciled by hash and the same bytes re-sent (#4).
- `AUTOMATION_DRY_RUN=true` now simulates and reports instead of failing every schedule (#5).
- Schedules that cannot be auto-signed are refused at creation (chain not allowlisted, mainnet disabled,
  value over cap, wallet without key) (#5).
- Live signing works on testnets; mainnet gating comes from the chain registry (#6, #17).
- SeaDrop signed schedules store the provider's live price as a ceiling (#7).
- SeaDrop `nftContract` must equal the scheduled contract; the router allowlist is checked on every SeaDrop
  route (#8).
- Referral rewards are paid on the referee's first confirmed mint (they could never fire before) (#11).
- Gas limit = estimate × 1.25 with a quantity-scaled cap instead of a fixed 300 000 (#12).
- OpenSea chain identifiers are mapped per chain; unmapped chains fail closed (#13).
- ERC-1155 `TransferSingle`/`TransferBatch` receipts report token IDs.

### Changed
- Chain-side waits poll every tick; only retries and OpenSea waits back off (0,0,0,0,30,60,120,240,300 s).
- One preparation path (`prepareMint`) for the executor, `/ready` and `/preflight`; `/preflight` has 13
  checks (adds automatic-signing gate and signing key).
- Dashboard shows the last status and launch time.
- `npm test` runs eslint (`no-undef`, `no-unused-vars`).

### Removed
- Manual signing (`/mint`, `/connect`, `/api/mint/*`), smart-account/delegation flow (`/authorize`,
  `/api/policy/*`, Pimlico, MetaMask delegation) and their dependencies: `@reown/appkit`,
  `@reown/appkit-adapter-ethers`, `viem`, `permissionless`, `@metamask/delegation-toolkit` (#10, #15).
- Signature-only wallet linking (a signing key is required).
- `REOWN_PROJECT_ID`, `REFERRAL_REQUIRE_ONCHAIN_ACTIVITY` and smart-account variables.
