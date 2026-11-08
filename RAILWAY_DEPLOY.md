# Railway deployment preparation

This repository is prepared for Railway, but **nothing has been deployed**. No Railway account, bot token, database, wallet key, or other secret was accessed or copied.

## Service configuration

Create one Railway service from this repository and let it build from the included `Dockerfile`. Keep the service at **one replica**: the application starts the Telegram poller, web server, and background worker together, and the project supports only one poller per bot token.

Attach a Railway volume at `/app/data`. The container initializes that directory's ownership at startup, then runs the Node process as the unprivileged `node` user. The database and eligibility file are stored at:

- `DATABASE_PATH=/app/data/bot.sqlite`
- `ELIGIBILITY_FILE=/app/data/eligible-addresses.json`

The volume must be mounted before the first production start. The image deliberately excludes local `data/` files, including any SQLite database or allowlist. If migrating existing data, take a consistent backup from the old host while the bot is stopped, then restore the database and any needed eligibility file to the mounted volume. This project archive contains no production database.

The container uses Node.js 22 and starts the existing all-in-one process with `node src/index.js`. Railway should provide `PORT`; set `PUBLIC_URL` to the service's public HTTPS URL so Telegram buttons resolve correctly.

## Variables and secrets

Set variables in Railway's secure service settings; never commit a `.env` file. Values required for the service include:

- `TELEGRAM_BOT_TOKEN`
- `ADMIN_TELEGRAM_IDS`
- `PUBLIC_URL`
- Production RPC URLs for the networks you intend to use
- `AUTOMATION_MASTER_KEY` when the bot creates platform wallets

For a fresh database, generate a new random 32-byte hex key and store it as a Railway secret; keep it stable across deployments. If migrating existing encrypted platform wallets, restore the **exact same** key from a secure backup. Rotating it makes existing encrypted wallet keys unreadable.

Signing mode is **not** baked into the image. MintPilot runs on mainnets only (v2.3.0 removed testnets).
Set the mode explicitly as Railway variables, following *Rollout on mainnet* in the README:

```text
# start here (mainnet dry run on one chain) …
AUTOMATION_ENABLED=true
AUTOMATION_DRY_RUN=true
AUTOMATION_ALLOWED_CHAINS=base
AUTOMATION_MAX_VALUE_ETH=0.01
TRUST_PROXY_HOPS=1
# … then a canary mint per chain with AUTOMATION_DRY_RUN=false, then widen chains and caps.
```

Remove `ENABLE_TESTNETS`, `*_SEPOLIA_RPC_URL`, `ROBINHOOD_TESTNET_RPC_URL`, `ENABLE_LOCALNET`,
`LOCAL_RPC_URL` and `AUTOMATION_MAINNET_ENABLED` from the service (they are logged as `Config:` warnings;
`AUTOMATION_MAINNET_ENABLED=false` with live signing refuses to start).

Health checks: set Railway's healthcheck path to `/readyz` (503 when the database, Telegram poll, worker
tick or event loop is unhealthy). Set `METRICS_TOKEN` to scrape `/metrics`. Railway sends SIGTERM on
redeploy; MintPilot drains for `SHUTDOWN_DRAIN_SECONDS` (default 20 s), so keep the platform's stop timeout
above that. `UV_THREADPOOL_SIZE=8` is set in the image.

The first log lines state the mode (`Automation: enabled=… dryRun=… chains=… masterKey=… perTxCap=…`),
the chains, the launch engine settings and the scale settings. Automatic signing submits live
transactions and must not be enabled with placeholder RPCs, an unknown wallet key, or an unreviewed schedule
queue. Upgrading: see `docs/RUNBOOK.md` → *Upgrading from v2.1* / *v2.0*.

Launch speed on Railway depends mostly on the RPC: set a low-latency paid endpoint per chain (e.g.
`ROBINHOOD_RPC_URL`) plus `RPC_FALLBACK_URLS_JSON`, and raise `RPC_RATE_LIMIT_PER_SECOND` to the provider's
limit. Railway containers keep their clock NTP-synced. Do not redeploy in the two minutes before a launch
(wallet leases must expire before a new instance can fire; armed mints survive the restart).

## Safe cutover checklist

1. Back up the current database and secrets securely. Do not put them in Git or in a container image.
2. Create the Railway service, attach `/app/data`, and set the required variables through Railway's secret manager.
3. Restore `bot.sqlite` and any required `eligible-addresses.json` to the volume. Confirm the restored database is from a consistent backup.
4. Deploy with the signing variables above. Check logs for the `Automation:` line, `Bot @... ready`, `Web listening`, and `Worker running`, and that `/readyz` answers 200; verify `/start` and a read-only `/preflight` check.
5. If the old deployment uses a Telegram webhook, plan the webhook-to-polling cutover explicitly. Do not run two pollers for the same bot token.
6. Verify the selected contracts, wallet addresses, RPC chain IDs, value caps, and schedule queue before allowing the live automatic worker to process schedules.

Railway bills by resource usage. Its current pricing page lists Hobby at a $5 monthly minimum with $5 usage credits; actual compute and storage may exceed those credits. Review current platform pricing before creating the service.
