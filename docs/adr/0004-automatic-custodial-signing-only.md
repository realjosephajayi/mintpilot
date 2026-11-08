# 0004. Automatic custodial signing only
Date: 2026-11-04 · Status: Accepted · Review findings: #10, #15

## Context
The code mixed three models: a manual browser-signing page (`/mint`, `/connect`), a dormant
smart-account/delegation subsystem (`/authorize`, Pimlico, MetaMask delegation), and custodial
auto-signing. Every user only had a custodial platform wallet whose key they cannot use in a browser, so
signing links could never be completed; `/api/policy/activate` referenced an undefined variable.

## Decision
MintPilot only signs automatically from custodial wallets. Removed: `/mint`, `/connect`, `/authorize`,
`/api/mint/*`, `/api/policy/*`, `/api/appkit/config`, `wallet.js`, the AppKit bundle, the smart-account
modules and their dependencies (`@reown/*`, `viem`, `permissionless`, `@metamask/delegation-toolkit`).
`/api/link/verify` requires a signing key. Schedules are refused at creation unless they can be auto-signed.
Old smart-account tables stay for data compatibility.

## Consequences
+ One execution path to secure, test and document; smaller dependency tree; no RPC URL sent to browsers.
− Users must trust the operator with keys. Non-custodial use would need a new, separately reviewed design.
− Schedules created by earlier versions in status `ready` (signing link sent) will expire; users re-create them.
