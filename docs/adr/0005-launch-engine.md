# ADR 0005 — Launch engine: pre-sign, fire on a millisecond timer, retry bad timing at once

Status: accepted (v2.2.0, 2026-11-04)

## Context
Two reference mints from another bot (Robinhood Chain, SeaDrop router, transactions
`0xc1e2…19cf4` and `0x305e…1ee5`) landed in blocks timestamped 17:00:00 and 15:30:01 UTC: the opening
second. They used the same technology as MintPilot (an EOA calling the SeaDrop router directly). The
difference was timing. MintPilot v2.1 woke on a 15 s tick, then made roughly ten sequential RPC round trips
(chain time, provider check, balance, router, simulate, estimate, fee data, plus `populateTransaction`'s own
fee and nonce reads) before broadcasting to one endpoint. On a chain with ~100 ms blocks that is up to
~150 blocks late. A transaction that reverted because it landed a moment too early ended the schedule.

Robinhood Chain (Arbitrum Orbit / Nitro) orders transactions first come, first served; priority fees do
not change position. Speed is arrival time at the sequencer.

## Decision
1. **Arm early.** From `LAUNCH_ARM_SECONDS` (60) before the opening, a launch session runs every check and
   signs the mint: gas limit = the configured cap (the estimate reverts while the stage is closed; EIP-1559
   charges gas used), fee headroom ×3 over the current base fee, tip 0 on FCFS chains. The signed attempt
   is persisted as `armed` with `fire_at_ms`.
2. **Fire on a timer, broadcast only.** At `T + LAUNCH_FIRE_OFFSET_MS` (50 ms, server clock) one UPDATE
   moves `armed → submitting` (only while the schedule is active) and the bytes go to every endpoint at
   once, on non-batching connections that bypass the read rate limiter. Connections are warmed 1.5 s
   before.
3. **Retry bad timing at once.** The receipt is polled every 200 ms. A mined revert re-queues the schedule
   and the session re-signs with a fresh nonce immediately, from a live estimate. While the stage is closed
   a one-call probe runs every 250 ms and a full send follows the moment it passes. Capped by
   `LAUNCH_MAX_CHAIN_RETRIES` (3). Decoded terminal reverts (sold out, wallet limit, invalid proof…) stop
   before any gas is spent.
4. **One parallel round trip for direct sends.** Router check, simulation, estimate, balance, latest block
   (base fee and chain time) and nonce run concurrently; signing uses explicit fields (no RPC).
5. **Follow the chain.** A SeaDrop `NotActive` start becomes the launch time in launch mode. A block
   timestamp more than 1 s ahead of the server clock corrects the fire time.
6. **Hand back to the tick** after `LAUNCH_HOT_WINDOW_SECONDS` (120) or for waits that are not about timing
   (funds, OpenSea back-off). `LAUNCH_ENGINE=false` restores v2.1 behaviour.

## Consequences
* Fire-to-send is a timer plus two SQLite statements; Hardhat end-to-end runs measured 1–2 ms from the fire
  time to the send and 3–6 ms to the node's acknowledgement (local node; real numbers depend on the RPC).
* A slightly early fire costs one cheap revert and an immediate re-sign. A fire offset of 50 ms trades that
  risk against arriving later than competitors; tune it from the recorded landing times.
* An on-chain re-sign only follows a mined revert, so no mint has happened; at most one transaction is
  pending per schedule; identical bytes are the only thing ever re-sent.
* The session holds the wallet's lease from arming to settlement: one nonce stream per wallet. Two launch
  schedules on one wallet at the same instant run one after the other.
* Signed bytes sit in the database for about a minute before the opening. They can only do what the user
  scheduled (mint to their wallet) or revert.
* Not covered: mints whose transaction comes from an API only once live (OpenSea REST) are built and sent
  at the fire time instead of pre-signed; priority-fee auctions (Base, Ethereum) use the RPC tip unless
  `PRIORITY_FEE_GWEI_JSON` is set.

## Verification
* `test/unit/launch-engine.test.js`: real worker + executor + signing on a virtual-clock chain; exact
  fire time, revert → re-sign within one probe interval of the opening, retry budget, SeaDrop later start,
  cancel while armed, restart recovery with identical bytes, funds top-up, dry run, engine off.
* `test/contracts/launch-engine.e2e.test.js`: the same on a real EVM (Hardhat), with a timestamp-gated
  contract, two endpoints per broadcast and a real reverted transaction consuming its nonce.
