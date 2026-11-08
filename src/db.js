'use strict';
// SQLite via Node's built-in driver (no native build step). Requires Node >= 22.13.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = [
  `
  CREATE TABLE users (
    telegram_id   TEXT PRIMARY KEY,
    username      TEXT,
    ref_code      TEXT NOT NULL UNIQUE,
    referred_by   TEXT,
    premium_until INTEGER NOT NULL DEFAULT 0,
    banned        INTEGER NOT NULL DEFAULT 0,
    blocked_bot   INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE wallets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    address     TEXT NOT NULL UNIQUE,          -- lowercase 0x...; one wallet = one Telegram account
    sig_type    TEXT NOT NULL,                 -- eoa | erc1271
    verified_at INTEGER NOT NULL
  );
  CREATE TABLE web_sessions (
    id          TEXT PRIMARY KEY,              -- 192-bit random, bearer secret delivered only via the Telegram chat
    kind        TEXT NOT NULL CHECK (kind IN ('link','mint')),
    telegram_id TEXT NOT NULL,
    ref_id      INTEGER,                       -- schedule id for kind=mint
    challenge   TEXT,                          -- exact message the wallet must sign (kind=link)
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE schedules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id    TEXT NOT NULL REFERENCES users(telegram_id),
    chain          TEXT NOT NULL,
    contract       TEXT NOT NULL,
    preset         TEXT NOT NULL,
    quantity       INTEGER NOT NULL,
    price_wei      TEXT NOT NULL,              -- per mint
    total_wei      TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    scheduled_at   INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','ready','submitted','confirmed','failed','cancelled','expired')),
    tx_hash        TEXT,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX idx_schedules_due ON schedules(status, scheduled_at);
  CREATE INDEX idx_schedules_user ON schedules(telegram_id, status);
  CREATE TABLE reminders_sent (
    schedule_id INTEGER NOT NULL,
    kind        TEXT NOT NULL,                 -- pre10 | pre1 | due
    sent_at     INTEGER NOT NULL,
    PRIMARY KEY (schedule_id, kind)
  );
  CREATE TABLE tracked_txs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id  TEXT NOT NULL,
    chain        TEXT NOT NULL,
    tx_hash      TEXT NOT NULL,
    schedule_id  INTEGER,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed','dropped')),
    block_number INTEGER,
    token_ids    TEXT,                         -- JSON array of ERC-721 ids received by the user's wallet
    created_at   INTEGER NOT NULL,
    UNIQUE (telegram_id, chain, tx_hash)
  );
  CREATE INDEX idx_tracked_pending ON tracked_txs(status, created_at);
  CREATE TABLE payments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id         TEXT NOT NULL,
    charge_id           TEXT NOT NULL UNIQUE,  -- telegram_payment_charge_id; makes grants idempotent
    amount              INTEGER NOT NULL,
    currency            TEXT NOT NULL,
    days                INTEGER NOT NULL,
    created_at          INTEGER NOT NULL
  );
  CREATE TABLE referrals (
    referee_id  TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rewarded')),
    created_at  INTEGER NOT NULL,
    rewarded_at INTEGER
  );
  CREATE TABLE conversations (
    telegram_id TEXT PRIMARY KEY,
    state       TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  CREATE TABLE smart_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    owner_wallet_id INTEGER NOT NULL REFERENCES wallets(id),
    chain TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    address TEXT NOT NULL,
    account_type TEXT NOT NULL CHECK (account_type IN ('erc4337','adapter')),
    implementation TEXT NOT NULL,
    implementation_hash TEXT,
    entry_point TEXT,
    factory TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paused','revoked','recovery_required')),
    created_tx_hash TEXT,
    activated_at INTEGER,
    paused_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (chain_id, address),
    UNIQUE (telegram_id, chain_id, owner_wallet_id)
  );
  CREATE INDEX idx_smart_accounts_user ON smart_accounts(telegram_id, status);
  CREATE INDEX idx_smart_accounts_chain_status ON smart_accounts(chain_id, status);

  CREATE TABLE assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    asset_type TEXT NOT NULL CHECK (asset_type IN ('native','erc20')),
    contract TEXT,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 36),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    created_at INTEGER NOT NULL,
    UNIQUE (chain_id, asset_type, contract)
  );
  CREATE INDEX idx_assets_chain_enabled ON assets(chain_id, enabled);

  CREATE TABLE asset_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    smart_account_id INTEGER NOT NULL REFERENCES smart_accounts(id),
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    confirmed_amount TEXT NOT NULL DEFAULT '0',
    reserved_amount TEXT NOT NULL DEFAULT '0',
    last_chain_block INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','disabled')),
    updated_at INTEGER NOT NULL,
    UNIQUE (smart_account_id, asset_id)
  );

  CREATE TABLE automation_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    smart_account_id INTEGER NOT NULL REFERENCES smart_accounts(id),
    session_key TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    module_address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paused','revoked','expired')),
    valid_after INTEGER NOT NULL,
    valid_until INTEGER NOT NULL,
    max_native_per_tx TEXT NOT NULL DEFAULT '0',
    max_native_total TEXT NOT NULL DEFAULT '0',
    native_spent TEXT NOT NULL DEFAULT '0',
    max_quantity_per_tx INTEGER NOT NULL DEFAULT 0,
    max_quantity_total INTEGER NOT NULL DEFAULT 0,
    quantity_spent INTEGER NOT NULL DEFAULT 0,
    owner_signature TEXT,
    activated_tx_hash TEXT,
    revoked_tx_hash TEXT,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (smart_account_id, policy_hash),
    CHECK (valid_until > valid_after),
    CHECK (max_quantity_per_tx >= 0),
    CHECK (max_quantity_total >= 0)
  );
  CREATE INDEX idx_policies_account_status ON automation_policies(smart_account_id, status, valid_until);

  CREATE TABLE policy_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id INTEGER NOT NULL REFERENCES automation_policies(id),
    chain_id INTEGER NOT NULL,
    target_contract TEXT NOT NULL,
    selector TEXT NOT NULL,
    preset TEXT NOT NULL,
    max_quantity INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    UNIQUE (policy_id, chain_id, target_contract, selector)
  );

  CREATE TABLE deposit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    smart_account_id INTEGER NOT NULL REFERENCES smart_accounts(id),
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    chain_id INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    block_hash TEXT NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    amount TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'seen' CHECK (status IN ('seen','confirmed','reorged','ignored')),
    confirmations INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    UNIQUE (chain_id, tx_hash, log_index)
  );
  CREATE INDEX idx_deposits_account_status ON deposit_events(smart_account_id, status, block_number);

  CREATE TABLE chain_cursors (
    chain_id INTEGER NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('deposits','executions','balances')),
    next_block INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chain_id, scope)
  );
  CREATE TABLE smart_account_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    owner_wallet_id INTEGER NOT NULL REFERENCES wallets(id),
    chain TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    account_id INTEGER REFERENCES smart_accounts(id),
    account_address TEXT,
    draft_hash TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('connect','create','policy')),
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_smart_account_sessions_lookup ON smart_account_sessions(session_id, kind, expires_at);
  `,
  `
  CREATE TABLE automation_session_keys (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id       INTEGER NOT NULL REFERENCES automation_policies(id),
    telegram_id     TEXT NOT NULL REFERENCES users(telegram_id),
    address         TEXT NOT NULL,
    ciphertext      TEXT NOT NULL,
    iv              TEXT NOT NULL,
    auth_tag        TEXT NOT NULL,
    salt            TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    revoked_at      INTEGER,
    UNIQUE (policy_id),
    UNIQUE (address)
  );
  CREATE INDEX idx_automation_session_keys_user ON automation_session_keys(telegram_id, revoked_at);
  `,
  `
  ALTER TABLE automation_policies ADD COLUMN delegation_json TEXT;
  ALTER TABLE wallets ADD COLUMN wallet_type TEXT NOT NULL DEFAULT 'linked';
  ALTER TABLE wallets ADD COLUMN ciphertext TEXT;
  ALTER TABLE wallets ADD COLUMN iv TEXT;
  ALTER TABLE wallets ADD COLUMN auth_tag TEXT;
  ALTER TABLE wallets ADD COLUMN salt TEXT;
  CREATE UNIQUE INDEX idx_wallets_one_platform_per_user ON wallets(telegram_id) WHERE wallet_type='platform';
  `,
  `
  ALTER TABLE schedules ADD COLUMN mint_spec TEXT;
  `
  ,`
  ALTER TABLE schedules ADD COLUMN trigger_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (trigger_mode IN ('manual','launch'));
  ALTER TABLE schedules ADD COLUMN launch_at INTEGER;
  CREATE INDEX idx_schedules_launch ON schedules(trigger_mode, status, launch_at);
  ALTER TABLE schedules ADD COLUMN end_at INTEGER;
  `
  ,`
  CREATE TABLE dashboard_sessions (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX idx_dashboard_sessions_expiry ON dashboard_sessions(expires_at, used_at);
  `
  ,`
  CREATE TABLE execution_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL REFERENCES schedules(id),
    chain TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('submitting','uncertain','submitted','reconciled','failed')),
    tx_hash TEXT,
    user_operation_hash TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX idx_execution_attempts_schedule ON execution_attempts(schedule_id, status, updated_at);
  CREATE UNIQUE INDEX idx_execution_attempts_active ON execution_attempts(schedule_id)
    WHERE status IN ('submitting','uncertain','submitted');
  `
  ,`
  CREATE TABLE wallet_execution_locks (
    wallet_address TEXT PRIMARY KEY,
    owner_token TEXT NOT NULL,
    lease_until INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_wallet_execution_locks_lease ON wallet_execution_locks(lease_until);
  `
  ,`
  -- Retry/backoff state for automatic execution (review #3) and the signed transaction persisted
  -- before broadcast so an ambiguous send can be reconciled by hash (review #4).
  ALTER TABLE schedules ADD COLUMN next_attempt_at INTEGER;
  ALTER TABLE schedules ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE schedules ADD COLUMN last_error TEXT;
  ALTER TABLE execution_attempts ADD COLUMN nonce INTEGER;
  ALTER TABLE execution_attempts ADD COLUMN raw_tx TEXT;
  CREATE INDEX idx_execution_attempts_open ON execution_attempts(status) WHERE status IN ('submitting','uncertain');
  `
  ,`
  -- Launch engine (ADR 0005). A pre-signed transaction waits in status 'armed' until its fire time;
  -- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Timing columns record how fast
  -- each attempt landed. schedules.chain_retries counts re-signs after an on-chain revert.
  CREATE TABLE execution_attempts_v11 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL REFERENCES schedules(id),
    chain TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('armed','submitting','uncertain','submitted','reconciled','failed')),
    tx_hash TEXT,
    user_operation_hash TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resolved_at INTEGER,
    nonce INTEGER,
    raw_tx TEXT,
    mode TEXT NOT NULL DEFAULT 'direct' CHECK (mode IN ('direct','armed')),
    launch_at INTEGER,
    fire_at_ms INTEGER,
    fired_at_ms INTEGER,
    acked_at_ms INTEGER,
    included_block INTEGER,
    included_at INTEGER,
    gas_used INTEGER
  );
  INSERT INTO execution_attempts_v11 (id, schedule_id, chain, wallet_address, status, tx_hash, user_operation_hash, error, created_at, updated_at, resolved_at, nonce, raw_tx)
    SELECT id, schedule_id, chain, wallet_address, status, tx_hash, user_operation_hash, error, created_at, updated_at, resolved_at, nonce, raw_tx FROM execution_attempts;
  DROP TABLE execution_attempts;
  ALTER TABLE execution_attempts_v11 RENAME TO execution_attempts;
  CREATE INDEX idx_execution_attempts_schedule ON execution_attempts(schedule_id, status, updated_at);
  CREATE UNIQUE INDEX idx_execution_attempts_active ON execution_attempts(schedule_id)
    WHERE status IN ('armed','submitting','uncertain','submitted');
  CREATE INDEX idx_execution_attempts_open ON execution_attempts(status) WHERE status IN ('armed','submitting','uncertain');
  CREATE INDEX idx_execution_attempts_hash ON execution_attempts(tx_hash);
  ALTER TABLE schedules ADD COLUMN chain_retries INTEGER NOT NULL DEFAULT 0;
  `,
  // 12 — v2.3.0: durable Telegram inbox. Updates are stored before the getUpdates offset advances, then
  // handled concurrently (in order per chat) and deleted when done, so a crash or restart replays
  // in-flight updates instead of losing them, and a slow chat never blocks the poller.
  `CREATE TABLE IF NOT EXISTS tg_inbox (
     update_id INTEGER PRIMARY KEY,
     chat_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     received_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS idx_tg_inbox_received ON tg_inbox(received_at);`,
  // 13 — per-user time zone for typing and showing times. An IANA name ("Africa/Lagos") or a fixed
  // offset ("UTC+1"); NULL means UTC. Additive: existing rows and code are unaffected.
  `ALTER TABLE users ADD COLUMN timezone TEXT;`
];

/** Attempt statuses that mean "a transaction exists or is about to": never sign a second one meanwhile. */
const OPEN_ATTEMPT_STATUSES = "('armed','submitting','uncertain','submitted')";

function migrate(db) {
  let version = db.prepare('PRAGMA user_version').get().user_version;
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

const depths = new WeakMap();

/**
 * Run fn inside a transaction; rolls back on throw. Re-entrant: nested calls use savepoints,
 * so domain functions (e.g. extendPremium) can be composed inside larger atomic operations.
 */
function tx(db, fn) {
  const depth = depths.get(db) || 0;
  const name = `sp_${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  depths.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  } catch (e) {
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw e;
  } finally {
    depths.set(db, depth);
  }
}

module.exports = { openDb, tx, OPEN_ATTEMPT_STATUSES };
