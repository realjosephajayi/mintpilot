'use strict';
// Entrypoint. `npm start` runs everything in one process; use --roles=bot,web,worker to split.
// Only ONE process may run the bot role (Telegram long polling) and ONE the worker role per database.
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { getChains } = require('./chains');
const { createTelegram } = require('./telegram');
const { createRpc } = require('./core/rpc');
const { verifyWalletSignature } = require('./core/verifySignature');
const { buildMintTx } = require('./core/mintTx');
const { createBotHandlers, COMMANDS } = require('./bot/handlers');
const { createPoller } = require('./bot/poller');
const { createWebServer } = require('./web/server');
const { createWorker } = require('./worker');
const { createLimiter } = require('./util/ratelimit');
const { createFastExecution } = require('./core/fastExecution');
const { createHealth } = require('./core/health');

let shuttingDown = null;

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--roles='));
  const roles = new Set((arg ? arg.slice(8) : 'bot,web,worker').split(','));
  const cfg = loadConfig();
  if (!cfg.botToken) { console.error('Set TELEGRAM_BOT_TOKEN in .env (create a bot with @BotFather).'); process.exit(1); }
  if (cfg.env === 'production' && !cfg.publicUrl.startsWith('https://')) { console.error('PUBLIC_URL must be https in production.'); process.exit(1); }
  for (const w of cfg.warnings) console.warn(`Config: ${w}`);

  const db = openDb(cfg.dbPath);
  const chains = getChains(cfg);
  const rpc = createRpc(chains, { ...cfg.rpc, etherscanApiKey: cfg.etherscanApiKey, log: console });
  const fastExecution = createFastExecution({ rpc, db, cfg, chains, log: console });
  const tg = createTelegram({ token: cfg.botToken, pacing: cfg.telegram });
  const now = () => Math.floor(Date.now() / 1000);

  // Every deploy states its signing mode in the logs, so a misconfigured image is visible immediately.
  const a = cfg.automation;
  console.log(`Automation: enabled=${a.enabled} dryRun=${a.dryRun} chains=${a.allowedChains.join(',') || '(none)'} masterKey=${a.encryptionKey ? 'set' : 'MISSING'} perTxCap=${a.maxValueEth} ETH`);
  console.log(`Chains: ${Object.values(chains).map((c) => `${c.key}(${c.chainId}, ${c.rpcUrls.length} rpc)`).join(' ')}`);
  const l = cfg.launch;
  console.log(`Launch engine: ${l.engine ? 'on' : 'OFF (tick only)'} arm=${l.armSec}s fireOffset=${l.fireOffsetMs}ms hotWindow=${l.hotWindowSec}s retry=${l.retryIntervalMs}ms receiptPoll=${l.receiptPollMs}ms maxChainRetries=${l.maxChainRetries} maxSessions=${l.maxSessions} tick=${cfg.workerTickMs}ms`);
  console.log(`Scale: botConcurrency=${cfg.bot.maxConcurrentUpdates} telegram=${cfg.telegram.globalPerSecond}/s rpcTimeout=${cfg.rpc.timeoutMs}ms rpcRate=${cfg.rpc.rateLimitPerSecond}/s/endpoint tracking=${cfg.trackingConcurrency}`);
  if (!fastExecution.isAvailable()) console.warn('Automatic signing is unavailable: set AUTOMATION_ENABLED=true and AUTOMATION_MASTER_KEY. New schedules will be refused.');

  let poller = null;
  let worker = null;
  let server = null;
  const sweepers = [];

  if (roles.has('bot')) {
    const me = await tg.getMe();
    await tg.setMyCommands(COMMANDS).catch(() => {});
    const limiter = createLimiter({ limit: cfg.bot.userMessagesPerWindow, windowSec: cfg.bot.userWindowSec });
    sweepers.push(setInterval(() => limiter.sweep(), 60_000));
    const handler = createBotHandlers({ tg, db, cfg, chains, rpc, buildMintTx, now, botUsername: me.username, limiter, log: console });
    // A handler failure must never leave the user without an answer.
    const onError = (u, e) => {
      const chatId = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id;
      if (chatId == null || e?.blocked) return null;
      return tg.sendMessage(chatId, 'Something went wrong on our side. Please try again in a moment; if it keeps happening, send /cancel and start over.');
    };
    poller = createPoller({ tg, db, handler, log: console, onError, maxConcurrent: cfg.bot.maxConcurrentUpdates });
    console.log(`Bot @${me.username} ready.`);
  }
  if (roles.has('worker')) worker = createWorker({ db, cfg, tg, rpc, chains, fastExecution });

  const health = createHealth({ db, cfg, chains, rpc, poller, worker, tg, roles });
  if (roles.has('web')) {
    const verifySignature = async (args) => {
      const provider = chains[cfg.erc1271Chain] ? await rpc.provider(cfg.erc1271Chain).catch(() => null) : null;
      return verifyWalletSignature({ ...args, provider });
    };
    const notify = (id, text) => tg.sendMessage(id, text);
    server = createWebServer({ db, cfg, verifySignature, notify, health });
    server.listen(cfg.port, () => console.log(`Web listening on :${cfg.port} (${cfg.publicUrl})`));
  }
  if (poller) poller.run();
  if (worker) { worker.start(); console.log('Worker running.'); }
  for (const t of sweepers) if (t.unref) t.unref();

  /**
   * Idempotent graceful shutdown: stop taking work (polling, new ticks, new launch sessions, new HTTP
   * connections), let in-flight work finish within SHUTDOWN_DRAIN_SECONDS, then close the database.
   * Unfinished Telegram updates stay in the durable inbox and armed mints stay persisted: both resume
   * on the next start.
   */
  shuttingDown = (code = 0) => {
    if (shuttingDown.started) return shuttingDown.started;
    const drainMs = cfg.shutdownDrainSec * 1000;
    console.log(`Shutting down (drain up to ${cfg.shutdownDrainSec}s)...`);
    const force = setTimeout(() => { console.error('Forced exit: drain exceeded its budget.'); process.exit(code || 1); }, drainMs + 5000);
    if (force.unref) force.unref();
    shuttingDown.started = (async () => {
      sweepers.forEach(clearInterval);
      if (poller) poller.stop();
      if (server) server.close();
      await Promise.allSettled([poller ? poller.drain(drainMs) : null, worker ? worker.drain(drainMs) : null]);
      health.stop();
      try { db.close(); } catch { /* already closed */ }
      console.log('Shutdown complete.');
      process.exit(code);
    })();
    return shuttingDown.started;
  };
  process.on('SIGINT', () => shuttingDown(0));
  process.on('SIGTERM', () => shuttingDown(0));
}

// A stray rejection must be visible, not silent; an uncaught exception leaves the process in an unknown
// state, so it shuts down (the supervisor restarts it; persisted state resumes).
process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason?.stack || reason));
process.on('uncaughtException', (e) => {
  console.error('Uncaught exception:', e?.stack || e);
  if (shuttingDown) shuttingDown(1); else process.exit(1);
});

main().catch((e) => { console.error(e); process.exit(1); });
