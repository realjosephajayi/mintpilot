# Code review (2026-11-04) — findings and fixes

Review of v2.0.0 (`mintpilot-opensea-rest-upgrade.zip`). Every finding is fixed in 2.1.0. Original
reproductions R1–R12 are kept, inverted, in `test/unit/review-regressions.test.js`.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | Adapter JSON could make the server read files (`/dev/zero` crash), fetch URLs (SSRF) | Key allowlists, file/URL keys rejected, operator providers, hardened fetch (ADR-0001) | R5, R6; `eligibility-providers`, `mint-adapters`, `bot` |
| 2 | "When the mint opens" failed for good on the first pre-launch revert | Opening time recorded; SeaDrop revert decoding; grace window (ADR-0002) | R3 ×2; `fast-execution`, `bot` |
| 3 | OpenSea 4xx retried forever, burning the shared quota; launch schedules never expired | OpenSea `code` mapping, backoff, deadlines, per-schedule check throttle | R4 ×2; `worker`, `eligibility-providers` |
| 4 | Pre-broadcast rejections left schedules silently "uncertain" forever | Sign → persist → broadcast → reconcile (ADR-0003) | R11 ×2; `fast-execution` |
| 5 | Dry run failed every schedule; partial chain allowlist failed other chains | Real dry run; refuse at creation | R1, R2; `core`, `worker` |
| 6 | Live signing impossible on testnets | Registry-driven chain support | R10; `fast-execution` |
| 7 | SeaDrop signed schedules stored the typed price, not the provider's | Live price as ceiling | R8; `mint-adapters` |
| 8 | SeaDrop `nftContract` unbound; router check only on OpenSea route | Binding + router check on all SeaDrop routes | R9; `fast-execution`, `preflight` |
| 9 | RPC URL (with API key) sent to browsers/wallets | Mint page removed; URLs stay server-side | `web` |
| 10 | Manual signing link unusable with custodial wallets | Auto-sign only (ADR-0004) | `web`, `bot`, `worker` |
| 11 | Referral rewards could never fire | Reward on first confirmed mint | R12; `worker` |
| 12 | Fixed 300 000 gas limit regardless of quantity/chain | Estimate × 1.25, quantity-scaled cap | `fast-execution`, `preflight`, `config` |
| 13 | OpenSea chain names compared raw (testnet ids, unmapped chains) | `opensea` id per chain; unmapped = fail closed | R7; `opensea-mint-adapter` |
| 14 | Rate limiter trusted the client-controlled first X-Forwarded-For entry | `TRUST_PROXY_HOPS` | `web` |
| 15 | `smartAccountAdapter` undefined in `server.js` | Legacy routes removed; eslint `no-undef` in `npm test` | lint |
| 16 | Docker image enabled live mainnet signing by default | ENV removed; startup mode log | `config` |
| 17 | Hard-coded mainnet list bypassed the mainnet gate for new chains | `chain.testnet` from the registry | `fast-execution` |

Also fixed while implementing: ERC-1155 `TransferBatch` parsing (ethers `Result.values` shadowing),
backoff no longer delays launches (chain-side waits poll every tick), `[::1]` localhost matching.

## Upgrade plan for more mint types (next)
1. **Adapter registry.** Move each mint type behind one interface (detect, config schema, phase reader,
   resolve, build, bindings, revert classifier, receipt parser) so `prepareMint`, `outcomes`, the wizard
   and `/preflight` call the registry instead of branching on adapter names.
2. **Shared capabilities.** ERC-20-priced mints (allowance → approve exact amount → mint), protocol fees
   read from contracts, per-adapter gas caps. ERC-1155 receipts are already parsed.
3. **Adapters, one PR each:** thirdweb Drop `claim(...)` (phase from `getActiveClaimConditionId`/
   `getClaimConditionById`), Zora timed sale `mint(mintTo, quantity, collection, tokenId, mintReferral,
   comment)` (+ mint fee), Manifold LazyPayableClaim `mint(creatorContract, instanceId, mintIndex,
   merkleProof, mintFor)`, OpenSea ERC-1155 drops (separate flow; the REST mint builder returns
   `UNSUPPORTED_DROP_TYPE`). Verify every ABI against the deployed contract on each chain.
4. **Per adapter:** Hardhat mock contract, encode/decode tests, binding tests, phase/revert tests, README
   section, CHANGELOG entry.
