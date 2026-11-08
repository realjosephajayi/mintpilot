# 0003. Persist the signed transaction before broadcasting it
Date: 2026-11-04 · Status: Accepted · Review finding: #4

## Context
`signer.sendTransaction()` signs and broadcasts in one call. When it threw, MintPilot could not know
whether a transaction existed, so every error (including clear node rejections) left the schedule stuck as
"uncertain" with no hash, no reconciliation and no message.

## Decision
`populateTransaction` → `signTransaction` → `hash = Transaction.from(raw).hash` → store hash, nonce and raw
bytes in `execution_attempts` (status `submitting`) → re-check the wallet lease → `broadcastTransaction`.
* Definite node rejections close the attempt as `failed` (see ADR-0002).
* Anything else marks it `uncertain`. The reconciler reads the nonce, then looks the hash up: seen →
  submitted; nonce still free → re-send the same raw bytes; nonce used by another tx for ≥ 60 s across two
  passes → release the attempt; past the deadline → failed with a message.
* One open attempt per schedule (unique partial index); cancellation and expiry are refused while one is
  open.

## Consequences
+ A crash or timeout can never produce a second, different transaction for the same schedule.
+ Uncertain states resolve automatically and the user is told once.
− The raw signed transaction is stored (it becomes public once broadcast; it contains no key).
