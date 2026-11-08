# MintPilot — Handoff: upgrade plan and adaptability structure (after v2.3.0)

**Written:** 5 Nov 2026 · **Code state:** v2.3.0 (mainnet-only, 10 chains, scale layer, thirdweb adapter)
**Companion docs:** `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md`, ADR-0001…0006, and the project document
*Public Readiness & Broad Mint Adaptability Upgrade Plan* (this handoff turns that plan into concrete work
against the v2.3.0 code).

This note covers everything that is **not** built yet, why it is not built, and exactly how to build it
without weakening the safety model. Protocol facts below were verified from published packages or source
at a given version; re-verify them at implementation time (ABIs, deployments and APIs change).

---

## 1. Where v2.3.0 stands

| Area | Status in v2.3.0 |
|---|---|
| Networks | Mainnets only: Ethereum, Base, Ink, Robinhood Chain, Arbitrum One, OP Mainnet, Zora, Shape, Unichain, Soneium (all ETH gas) |
| Adapters | Presets · SeaDrop public · SeaDrop signed (provider) · Merkle / signature (inline or provider) · token-gated · OpenSea REST ERC-721 SeaDrop V1 (all 10 chains) · **thirdweb Drop ERC-721/1155** (public, native ETH) |
| Launch speed | Pre-sign at T−60 s, fire at T+50 ms on a ms timer, parallel broadcast, immediate re-sign after a timing revert (ADR-0005) |
| Many users | Durable inbox + per-chat concurrent dispatch, outbound pacing, RPC timeouts + priority lanes, async key derivation, parallel balances/discovery, health/readiness/metrics, graceful drain |
| Release safety | `npm run release` refuses `.env`, DBs, keys, committed tokens; CI runs lint, unit, contract tests and the release gate |
| Tests | 227 unit (`node:test`) + 23 Hardhat (incl. thirdweb on a real EVM), lint clean |

**Operator actions that code cannot do** (do these before inviting the public):
1. Rotate the Telegram bot token (it was inside the uploaded zip). Build future zips with `npm run release`.
2. Set `AUTOMATION_MASTER_KEY` (`openssl rand -hex 32`), store it in a secret manager **and** an offline
   backup. Losing it makes every custodial wallet unrecoverable.
3. Replace the temporary `*.trycloudflare.com` `PUBLIC_URL` with a stable HTTPS domain (a named Cloudflare
   tunnel or a platform domain). Quick-tunnel URLs change on every restart and break every link already sent.
4. Paid RPC endpoint for every chain in `AUTOMATION_ALLOWED_CHAINS`, and `RPC_RATE_LIMIT_PER_SECOND` set
   to the plan's limit (all users share it).
5. Dry run → canary mint per chain → widen chains and caps (README, *Rollout on mainnet*).
6. Terms, privacy policy, custody disclosure and a support contact (required for a paid Telegram bot).

---

## 2. What is not built, and why

| Item | Why it was not shipped in v2.3.0 | Section |
|---|---|---|
| Moving every existing adapter into the registry | A refactor of the proven execution path; needs its own change set with the compatibility tests below so v2.2 behaviour cannot regress | §4 |
| ERC-20-priced mints (approve + mint) | Needs a durable multi-step attempt model (two hashes, two nonces, cancellation semantics); a half-built version could approve without minting | §5.2 |
| thirdweb allowlist phases | Needs a per-wallet proof provider (or the creator's published tree); MintPilot must not guess proofs | §5.3 |
| Manifold, Zora, Magic Eden, Foundation, Sound, Highlight | Each has several ABI generations and per-chain deployments; each needs a verified deployment list and its own fixture tests | §6 |
| Verified-ABI guided minting, declarative recipes | Broad coverage without arbitrary calldata requires an argument-binding validator first | §7 |
| Copy-a-mint | Calldata can embed another wallet's proof, signature, nonce or referral; research-only until postconditions can be verified | §7.3 |
| Non-ETH chains (Polygon, ApeChain, Berachain, Avalanche, BNB, HyperEVM, Monad, …) | Caps are ETH-denominated; a 1-unit cap means very different money per chain | §8 |
| Abstract (zkSync stack) | Gas units and estimation differ by an order of magnitude from EVM L2s; needs its own gas policy and tests | §8 |
| Multi-replica scaling | SQLite + in-process leases: exactly one bot poller and one worker per database | §9 |
| KMS/HSM custody, per-user daily limits, audit | Infrastructure and an independent review, not code alone | §10 |
| Published performance numbers | Need repeated mainnet canaries with production RPCs | §11 |

---

## 3. Safety invariants every change must keep

1. **No arbitrary calldata.** Every transaction comes from a reviewed adapter or a validated recipe;
   users never supply raw calldata, URLs or file paths.
2. **Bindings before signing:** chain, target, recipient = scheduled wallet, quantity, token ID, payment
   asset, price, fee recipient, spend ceiling. Adapter output is re-validated by common code (§4.3).
3. **Simulate the exact transaction**, then sign → persist → broadcast → reconcile by hash (ADR-0003).
4. **Fail closed** with a reason when anything is unknown (allowlist without provider, ERC-20 without the
   payment capability, unverified deployment, ambiguous recipient).
5. **Success means the NFT arrived:** report token IDs only from Transfer/TransferSingle/TransferBatch to
   the scheduled wallet.
6. **One nonce stream per wallet** (wallet lease) and **one open attempt per schedule**.
7. **Never claim** "fastest", "first block" or guaranteed success.

---

## 4. Adaptability structure (target)

### 4.1 Layout

```
src/core/adapters/
  index.js            registry: id → adapter module; detect() fan-out; capability lookup
  _contract.md        the adapter contract below (kept next to the code)
  direct.js           presets (moved from mintAdapters.js)
  seadrop.js          public + signed + token-holder (moved from mintAdapters.js / outcomes.js)
  opensea-rest.js     OpenSea REST resolver (moved from eligibilityProviders.js / openSeaDrops.js)
  merkle.js           generic Merkle shapes
  signature.js        generic signature shapes
  token-gate.js
  thirdweb.js         ✅ already in this shape
  manifold.js, zora.js, magiceden.js, foundation.js, sound.js   (new, §6)
  abi-guided.js       verified-ABI guided minting (§7.1)
  recipe.js           declarative recipes (§7.2)
src/core/capabilities/
  payment.js          native + erc20 (exact approval state machine)
  eligibility.js      provider kinds: merkle, signature, seadrop-signed, thirdweb-allowlist, platform-api
  standards.js        erc721 / erc1155 receipt expectations
  phase.js            normalized phase shape + validation
src/core/plan.js      transaction-plan type + validatePlan() (independent of adapters)
```

### 4.2 Adapter contract

```js
module.exports = {
  id: 'thirdweb-drop', version: '1.0.0', label: 'thirdweb Drop',
  standards: ['erc721', 'erc1155'],
  chains: '*' | ['base', 'ethereum'],           // or deployment-address map per chain (Zora, Manifold)
  userKeys: [...], storedKeys: [...],            // key allowlists (USER_KEYS / STORED_KEYS today)
  capabilities: { phase: true, eligibility: ['public'], payment: ['native'], presign: true },

  async detect(ctx)            -> null | { confidence, summary, needs: ['tokenId'] }   // discovery fan-out
  async readPhases(ctx)        -> [{ id, start, end, price, currency, walletLimit, remaining, allowlist }]
  phaseBlocker(phase)          -> null | 'reason'                                      // fail-closed gate
  async resolveEligibility(schedule, ctx) -> proof/signature data bound to wallet (providers only)
  buildPlan(spec, schedule)    -> Plan (§4.3)                                          // pure, no I/O
  classifyRevert(data)         -> null | { kind: 'not-open'|'terminal'|'transient'|'user-action', startAt?, reason }
  expectedReceipt(plan)        -> { standard, tokenId?, quantity }                     // for receipt checks
};
```

`thirdweb.js` already exports `readPhases`, `phaseAt`, `phaseBlocker`, `normalize` (→ `buildPlan`),
`classifyRevert`, `USER_KEYS`, `STORED_KEYS`. Use it as the template.

### 4.3 Transaction plan (common validator)

```js
{
  chainId, chainKey,
  steps: [                                   // ordered; usually one; ERC-20 adds an approval step
    { kind: 'mint', to, selector, data, valueWei, decoded: { fn, args } },
  ],
  recipient, quantity, tokenId: null | '7', standard: 'erc721' | 'erc1155',
  payment: { asset: 'native' | '0xToken', unitPrice, protocolFee, total, maxSpend },
  eligibility: { kind: 'public' | 'provider:<id>', note },
  phase: { start, end, walletLimit },
  gasClass: 'standard' | 'heavy',
  presignable: true | false,
  expectedEvents: [{ type: 'Transfer' | 'TransferSingle' | 'TransferBatch', to: recipient }]
}
```

`validatePlan(plan, schedule, cfg, chains)` runs **after** the adapter and **before** simulation:
`chainId` matches the registry; every step's `to` is the schedule contract or an allowlisted router for
that adapter and chain; decoded recipient = scheduled wallet; quantity/token ID match; `payment.total ≤
schedule.total_wei ≤ caps`; native `valueWei` equals the plan total for exact-price adapters; ERC-20 steps
approve exactly `total` to the expected spender; no step is a multicall or delegatecall wrapper.

### 4.4 Migration steps (one PR each, no behaviour change)

1. Add `src/core/plan.js` + `validatePlan`; call it from `prepareMint` for every adapter (direct path first).
2. Add `adapters/index.js`; register `thirdweb`. Replace `buildFromSpec`'s `if (spec.adapter === …)` chain
   with a registry lookup; keep `mintAdapters.js` exports as thin wrappers for one release.
3. Move direct → seadrop → opensea-rest → merkle → signature → token-gate into modules. After each move,
   delete the adapter-name branches from `handlers.js` (wizard menus come from `registry.detect`),
   `prepareMint.js` (`isSeaDropRoute` → `adapter.routers(chain)`), `preflight.js` (`usesLiveData` →
   `adapter.capabilities.liveData`) and `outcomes.js` (revert decoding → `adapter.classifyRevert`).
4. **Gate:** all existing tests pass unchanged; add a compatibility test per adapter that encodes the same
   v2.2 fixtures and asserts byte-identical calldata.

---

## 5. Capabilities to build

### 5.1 ERC-1155 everywhere (mostly done)
Receipts already parse TransferSingle/TransferBatch; thirdweb binds `tokenId`. Remaining: a `token_id`
column on `schedules` (today it lives in `mint_spec`) for dashboards and `/myschedules`, and per-adapter
`expectedReceipt` checks so "confirmed" requires the expected token ID and quantity.

### 5.2 ERC-20 payments — exact-approval state machine
Schema (migration 13):

```sql
CREATE TABLE attempt_steps (
  id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL REFERENCES execution_attempts(id),
  step_index INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('approve','mint')),
  status TEXT NOT NULL CHECK (status IN ('pending','signed','submitted','confirmed','failed','skipped')),
  tx_hash TEXT, nonce INTEGER, raw_tx TEXT, spender TEXT, amount TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (attempt_id, step_index)
);
```

Rules: read `decimals`, `balanceOf`, `allowance(wallet, spender)`; if allowance < total, approve **exactly**
`total` (never unlimited); the mint step is not signed until the approval receipt is confirmed (or allowance
re-read ≥ total); pre-sign at T−60 both steps with consecutive nonces only when the approval can be mined
before T (approve at arm time, mint pre-signed with nonce+1). Cancel: if the approval confirmed and the mint
never ran, offer "reset allowance to 0" (a signed `approve(spender, 0)`). Fees/spend caps need a per-token
cap table (`ERC20_CAPS_JSON`: token → max units) because ETH caps do not apply.
Tests: approval failure, replacement, restart between steps, cancellation, no mint before approval,
allowance already sufficient (skip step), fee-on-transfer tokens refused.
Unlocks: thirdweb ERC-20 phases, Zora ERC20Minter, Manifold ERC-20 claims, Magic Eden ERC-20 stages.

### 5.3 Eligibility providers for platform allowlists
Add provider kinds with the existing hardened fetch (HTTPS, no redirects, 64 KB, wallet/contract/chain/
quantity binding):
* `thirdweb-allowlist` → returns `{ proof[], quantityLimitPerWallet, pricePerToken, currency }` for the
  wallet; the adapter passes it as `AllowlistProof` and the plan validator checks the price/currency it
  implies against the spend ceiling.
* `platform-api` (generic) for creators who expose an official per-wallet signature endpoint.
Never fetch from user-supplied URLs; never reuse another wallet's proof or signature.

### 5.4 Phase reader and verified launch times
Every adapter returns normalized phases; the wizard shows them (thirdweb already does) and the launch engine
uses the chain-read start. When no trustworthy time exists, keep the current behaviour: the user supplies
the window and it is labelled unverified.

---

## 6. Protocol adapters — verified facts and build notes

Build in this order (demand and verified support), each behind its own flag and chain allowlist.

| # | Adapter | Verified source (version) | Mint call(s) | Build notes |
|---|---|---|---|---|
| 1 | **Manifold claims** | creator-core-extensions-solidity @ 38eae00 | `mint(address creatorContractAddress, uint256 instanceId, uint32 mintIndex, bytes32[] merkleProof, address mintFor)`; also `mintBatch`, `mintProxy`, `mintSignature`; read `getClaim(creatorContract, instanceId)` | Target is the **claim extension**, not the NFT contract: keep a per-chain extension address list from Manifold's official deployments, verify bytecode, bind `creatorContractAddress` to the schedule contract and `mintFor` to the wallet. Separate ERC-721 and ERC-1155 extensions. The Manifold fee is added to `msg.value`; read it from the extension. ERC-20 claims need §5.2. |
| 2 | **Zora (1155 timed sale)** | @zoralabs/protocol-deployments 0.7.6 | Timed sale strategy `0x777777722D078c97c6ad07d9f36801e653E356Ae`: `mint(address mintTo, uint256 quantity, address collection, uint256 tokenId, address mintReferral, string comment)`; ERC20 minter: `mint(address mintTo, uint256 quantity, address tokenAddress, uint256 tokenId, uint256 totalValue, address currency, address mintReferral, string comment)`; 1155 impl: `mint(address minter, uint256 tokenId, uint256 quantity, address[] rewardsRecipients, bytes minterArguments)` | Deployed on chains 1, 10, 8453, 42161, 81457, 7777777 in that package — **not Robinhood or Ink**, so the adapter's chain list must exclude them. Model the per-token mint fee from the contract (do not hard-code). `mintReferral` must be the zero address or an operator-configured address, never user input. |
| 3 | **Magic Eden ERC721M** | npm `@magiceden-oss/erc721m` 0.1.2; magicdrop @ 32cb139 | 0.1.2: `mint(uint32 qty, bytes32[] proof, uint64 timestamp, bytes signature)` (selector `0xefb6b11f`); current ERC721M: `mint(uint32 qty, uint32 limit, bytes32[] proof, uint256 timestamp, bytes signature)`; clones: `mintPublic(address to, uint256 qty)`, `mintAllowlist(address to, uint256 qty, bytes32[] proof)`; reads `getStageInfo`, `getActiveStageFromTimestamp` | Three generations: detect by selector **and** read functions, never by name. Public stages with an empty proof/signature work without a provider; cosigned stages need Magic Eden's signature (only through an authorized API). |
| 4 | **Foundation** | fnd-protocol @ 1087a8b (2022) | `mintFromFixedPriceSale(address nftContract, uint16 count, address payable buyReferrer)` | Old; check current deployments and whether Foundation still runs drops before investing. `buyReferrer` = zero. |
| 5 | **Sound SuperMinter** | @soundxyz/sound-protocol 1.9.0 | `mintTo(MintTo p)` with a 16-field struct | Struct-heavy: build only with a full field-by-field binding table and fixture tests from real mints. |
| 6 | **Highlight** | **not verified** | — | Do not implement until an official ABI and deployment list are obtained. |
| 7 | **OpenSea ERC-1155 / other REST flows** | — | — | Only if OpenSea's API documents a transaction path for them; the current endpoint is ERC-721 SeaDrop V1 only. |

Per-adapter acceptance (from the project plan §10): configuration (unknown keys rejected), encoding vs the
real ABI, binding (wrong chain/target/recipient/quantity/token/payment/price/fee recipient/ceiling
rejected), eligibility, phase/error, payment, simulation/execution (pre-sign, cancel race,
persist-before-broadcast, restart, no duplicate), receipt (721/1155 single/batch, unrelated logs, missing
transfer), chain (local fixture + a mainnet canary per advertised chain), load (many schedules firing).
`test/contracts/thirdweb.test.js` + `contracts/test/ThirdwebDropMock.sol` show the fixture pattern: a mock
written from the protocol's published source that enforces the same checks.

---

## 7. Long-tail coverage without arbitrary calldata

### 7.1 Verified-ABI guided minting (`abi-guided.js`)
* Input: verified ABI (now available on every chain via `abiSources.js`).
* Candidates: `payable` (or price-0 `nonpayable`) functions named like `mint|claim|purchase|buy` whose
  every argument maps to a **known source**: `address` → scheduled wallet (only if the parameter name is
  `to|receiver|recipient|minter|account|_to` and simulation shows the NFT goes there); `uint*` →
  quantity/tokenId only by name (`quantity|amount|qty|count|_quantity` / `tokenId|id|_id`); constants set by
  the operator. Reject `bytes`, `bytes32[]`, tuples, arrays of addresses, any unnamed parameter.
* Simulate from the wallet with `eth_call` and, where the node supports it, check the receipt-equivalent
  postcondition (balance before/after via `balanceOf`) in a follow-up call; otherwise mark the plan
  *Manual review required* and do not auto-sign.
* The wizard shows the decoded call, recipient, quantity, token ID, value and maximum spend for confirmation.

### 7.2 Declarative recipes (`recipe.js`)
Reviewed JSON (operator-signed, versioned, disabled by default) that names: chain(s), target, function
signature, per-argument source (`wallet`, `quantity`, `tokenId`, `const:<value>`, `read:<fn>`,
`provider:<id>.<field>`), spend rule, phase reads, expected events and decoded error selectors. A linter
validates recipes against the ABI; recipes have fixture tests like adapters. No JavaScript, ever.

### 7.3 Copy-a-mint (research only)
Decode a successful mint tx; classify each argument (wallet-bound, signature, proof, nonce, timestamp,
referral, quantity, constant). Refuse if any wallet-bound authorization is present. Even when all
arguments are bindable, keep it behind a flag with *Manual review required* until a postcondition check
(the NFT arrives at the scheduled wallet) is reliable on the target chain. Never rebroadcast raw calldata.

---

## 8. Adding a chain

**ETH-gas chain checklist** (what v2.3.0 did for six chains):
1. Chain id, public RPC and explorer from official docs (cross-check viem's chain definition).
2. `stack` and `ordering` (`fcfs` for Arbitrum/Orbit: tip 0; `fee` for Ethereum/OP Stack).
3. Blockscout instance for `abiApi` (or leave `null`: Sourcify/Etherscan are tried).
4. OpenSea identifier from the opensea-js `Chain` enum (or `null` → OpenSea route refused there).
5. Add to `DEFS` in `src/chains.js`; `<KEY>_RPC_URL` works automatically.
6. Canary mint; set `GAS_CAP_JSON` from `gas_used`; then add to `AUTOMATION_ALLOWED_CHAINS`.

Candidates with ETH gas and OpenSea support: **B3** (`b3`), **MegaETH** (`megaeth`), **Blast** (`blast`;
declining usage — 0x removed it in 2026). Verify each as above.

**Non-ETH chains** (Polygon `POL`, ApeChain `APE`, Berachain `BERA`, Avalanche `AVAX`, BNB, HyperEVM
`HYPE`, Monad `MON`, Sei, Ronin, Flow EVM, Somnia…) need first:
* `currency` used in every message (replace hard-coded "ETH" in handlers/worker texts with
  `chains[k].currency`);
* per-chain caps: `MAX_MINT_VALUE_JSON` / `AUTOMATION_MAX_VALUE_JSON` in native units, and **refuse** a
  non-ETH chain without its caps (otherwise `1` means 1 BNB or 1 POL);
* fee quirks: Polygon's minimum priority fee (use the RPC suggestion, never 0), BNB legacy pricing,
  Avalanche fine with EIP-1559;
* optional: USD-normalized caps from a price oracle (adds an external dependency; keep native caps as the
  hard limit).

**Abstract (zkSync stack, ETH gas, OpenSea `abstract`)**: standard EIP-1559 transactions work, but gas
units are much larger than on EVM L2s and estimates include pubdata. Needs `stack: 'zksync'`, its own gas
cap defaults from canaries, and tests against an Abstract fork or canary before enabling.

---

## 9. Scaling out (more than one process)

v2.3.0 serves many users from **one** process per database: concurrency is inside the process. To run
several replicas:
1. **Datastore:** PostgreSQL (or another transactional SQL store). Port `db.js` migrations; keep the same
   constraints (one open attempt per schedule, reminder PK, charge-id unique). Use `SELECT … FOR UPDATE SKIP
   LOCKED` for candidate claiming.
2. **Wallet leases:** move `walletExecutionLocks` to the database (row with owner + expiry) or Redis with
   fencing tokens; the launch engine must hold the lease for the whole session (as today).
3. **Telegram:** switch to a webhook (`setWebhook` with a secret token) behind a load balancer; the
   durable inbox becomes a shared table; per-chat ordering via `SELECT … FOR UPDATE` on a chat row or a
   partitioned queue keyed by chat id.
4. **Rate limits:** per-user limiter and RPC token buckets in Redis (shared across replicas), or one RPC
   gateway process.
5. **Workers:** shard schedules by `wallet_address` hash so one wallet's nonce stream stays in one worker.
6. **Gate:** fault-injection tests (kill a replica mid-arm, mid-broadcast) show no duplicate transaction.

---

## 10. Custody hardening

* Master key from a KMS/HSM (envelope encryption: the KMS decrypts a data key at boot; rotation re-wraps
  data keys, not every wallet). Document operator access and recovery.
* Per-user and per-wallet **daily** automated-spend limits (sum of `execution_attempts` value per 24 h) in
  addition to the per-transaction cap; visible in `/plans`.
* Encrypted, off-host, monitored backups with a quarterly restore drill (`docs/RUNBOOK.md` top).
* Independent security review of `custodialWallets.js`, `fastExecution.js`, `web/server.js` (import
  portal) and every adapter before raising caps.
* Optional later: scoped session keys / smart accounts — only with a separate threat model.

---

## 11. Performance validation

Per chain and RPC setup, run repeated canaries and record (queries in `docs/RUNBOOK.md` → timing report):
scheduled vs actual fire time, fire → first RPC acceptance per endpoint, inclusion block and its delta to
the opening, success/revert/timeout/dropped rates, gas estimate vs used per adapter and quantity, RPC
throttling and failover time, and bot queue latency under concurrent users (`/metrics`). Tune
`LAUNCH_FIRE_OFFSET_MS`, gas caps and provider routing from these numbers only. Publish observed numbers,
not claims.

---

## 12. Public support matrix (publish and keep current)

| Chain | Adapter | Mode | Standard | Payment | Eligibility | Pre-sign | Status |
|---|---|---|---|---|---|---|---|
| all 10 | Presets (`mint()`, `mint(uint256)`, `publicMint(uint256)`) | timed / launch (user window) | 721/1155 | ETH | public | yes | Supported after canary |
| all 10 | SeaDrop public | launch (on-chain window) | 721 | ETH | public | yes | Supported after canary |
| all 10 | SeaDrop signed | launch | 721 | ETH | provider | no (fresh signature) | Supported with provider |
| all 10 | OpenSea REST SeaDrop V1 | launch | 721 | ETH | OpenSea API | no | Supported (shared API quota) |
| all 10 | Merkle / signature shapes | timed / launch | 721 | ETH | inline (1 wallet) or provider | inline: yes | Supported / with provider |
| all 10 | Token-gated | timed / launch | 721 | ETH | on-chain balance | yes | Supported after canary |
| all 10 | thirdweb Drop | launch (phase start) | 721 / 1155 | ETH | public | yes | Supported after canary |
| all 10 | thirdweb Drop | — | 721 / 1155 | ERC-20 or allowlist | — | — | Not supported (§5.2, §5.3) |
| — | Manifold, Zora, Magic Eden, Foundation, Sound, Highlight | — | — | — | — | — | Not supported yet (§6) |

"Supported after canary" = the operator has run one successful canary on that chain. A platform name alone
is never a claim of complete support.

---

## 13. Suggested order of work

1. Operator actions (§1) and a dry run + canaries on the chains you will advertise first.
2. Registry migration (§4.4) with compatibility tests.
3. ERC-20 payment state machine (§5.2) → thirdweb ERC-20 phases.
4. thirdweb allowlist provider (§5.3).
5. Manifold (§6.1), then Zora (§6.2) on its supported chains, then Magic Eden (§6.3).
6. Non-ETH chain support (§8) if users ask for those chains.
7. Verified-ABI guided minting (§7.1) and recipes (§7.2).
8. Custody hardening (§10) before raising caps; scale-out (§9) when one process is no longer enough
   (watch `mintpilot_event_loop_delay_ms` and `mintpilot_updates_queued`).
