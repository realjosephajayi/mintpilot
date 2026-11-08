# 0006. Mainnet-only runtime and public-scale request handling
Date: 2026-11-05 · Status: Accepted

## Context
The operator asked to remove testnets entirely and make every adapter usable on mainnet for many users at
once. v2.2 kept three testnets, a local-node mode and a separate `AUTOMATION_MAINNET_ENABLED` gate, and the
responsiveness audit found: sequential update handling (one slow command delayed everyone), 5-minute RPC
timeouts with hidden retries, synchronous scrypt on the event loop, no outbound pacing, and verified-ABI
lookup that only worked where the explorer happened to be Blockscout.

## Decision
1. The chain registry contains mainnets only; tests inject a local chain. Signing is controlled by
   `AUTOMATION_ENABLED`, `AUTOMATION_DRY_RUN`, `AUTOMATION_ALLOWED_CHAINS` and the value caps. A leftover
   `AUTOMATION_MAINNET_ENABLED=false` with live signing stops startup instead of being silently ignored.
2. Rollout safety moves from testnets to mainnet dry runs and per-chain canary mints with small caps.
3. Add only ETH-gas chains whose ids, RPCs and OpenSea identifiers were verified, so the ETH caps keep
   their meaning. Non-ETH chains wait for per-chain caps.
4. Telegram updates go through a durable inbox and per-chat queues with bounded concurrency; outbound
   messages are paced; RPC requests have hard timeouts and priority lanes; key derivation leaves the event
   loop. Health, readiness and metrics endpoints are part of the product.
5. Protocol adapters start moving into `src/core/adapters/<id>.js` (thirdweb first) with a uniform shape.

## Consequences
* Better: no accidental testnet/mainnet confusion; one switch set; a slow user cannot stall others; crash or
  deploy loses no in-flight update; operators can see queue depth, stale ticks, uncertain attempts and RPC
  health.
* Worse: no free rehearsal network: canaries cost real (small) amounts. Public default RPCs are not enough
  for ten chains under load; paid endpoints are required.
* Watch: still one process per database for the bot and worker roles (SQLite). Multi-replica scaling needs
  the shared-datastore work in docs/HANDOFF.md.
