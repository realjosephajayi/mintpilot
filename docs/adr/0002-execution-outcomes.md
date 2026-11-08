# 0002. One outcome taxonomy for automatic execution
Date: 2026-11-04 · Status: Accepted · Review findings: #2, #3, #4, #5

## Context
The worker decided what to do by searching error text (`includes('preflight')`,
`startsWith('RPC unavailable')`). Consequences: a pre-launch revert failed launch schedules for good;
non-retryable OpenSea 4xx errors were retried every 15 s forever (burning the shared API quota); node
rejections became a permanent silent "uncertain"; dry run failed every schedule.

## Decision
The executor returns `{ outcome, userReason, … }` with `outcome` ∈
`submitted | wait | retry | terminal | uncertain | dry-run | lease-lost` (`src/core/outcomes.js`). Only
`worker.applyOutcome` changes schedule state.

| Source | Outcome |
|---|---|
| SeaDrop `NotActive` before stage end | wait (next attempt at the decoded stage start) |
| Other decoded SeaDrop errors | terminal |
| Unknown revert before opening + `LAUNCH_GRACE_SECONDS` | wait; after it: terminal |
| Simulation/RPC transport failure, provider 429/5xx, router read failure | retry |
| Balance below value or value+gas, node `INSUFFICIENT_FUNDS`, OpenSea `INSUFFICIENT_BALANCE` | wait + one funds notice |
| OpenSea `NOT_MINTING`/409 | wait (API-costly: backs off) |
| OpenSea eligibility/config codes, other 4xx, spec/binding errors, gas over cap, disabled chain | terminal |
| Node `NONCE_EXPIRED`, `REPLACEMENT_UNDERPRICED` | retry (re-sign with a fresh nonce) |
| Signed but broadcast result unknown | uncertain (reconcile by hash) |
| `AUTOMATION_DRY_RUN=true` after all checks | dry-run |

Backoff: `retry` and API-costly waits use 0, 0, 0, 0, 30, 60, 120, 240, 300 s (and `Retry-After`).
Chain-side waits poll every tick. Every schedule has a deadline (`end_at`, else start + `LAUNCH_MAX_WAIT_SECONDS`).

## Consequences
+ Behaviour is testable per outcome; launches are not missed by growing backoff.
+ Each notice is sent at most once per schedule and kind.
− Adding a new failure source means adding a classification (and a test) rather than a string match.
