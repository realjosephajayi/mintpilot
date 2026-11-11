'use strict';
const { upsertUser, getUser, planOf, extendPremium, revokePremium, setUserTimezone, grantAdminPremium, isPermanentPremium } = require('../core/users');
const { registerReferral, referralStats } = require('../core/referrals');
const { createLinkSession } = require('../core/sessions');
const { listWallets, removeWallet, normalizeAddress } = require('../core/wallets');
const { createSchedules, listSchedules, cancelSchedule, ScheduleError } = require('../core/schedules');
const { getSchedule } = require('../core/schedules');
const { addTrackedTx, TrackError, HASH_RE } = require('../core/tracking');
const { invoiceFor, validatePreCheckout, recordPayment } = require('../core/payments');
const { PRESETS, byId, totalWei } = require('../core/presets');
const { ensurePlatformWalletAsync } = require('../core/custodialWallets');
const { checkEligibility, loadEligibilityFile } = require('../core/eligibility');
const { createDashboardSession } = require('../core/dashboard');
const { checkMintReadiness } = require('../core/readiness');
const { runPreflight } = require('../core/preflight');
const { resolveMintSpec } = require('../core/eligibilityProviders');
const { getOpenSeaDrop, searchOpenSeaCollections, getOpenSeaCollectionByContract, assertDropMatchesSchedule, buildOpenSeaMintTransaction } = require('../core/openSeaDrops');
const { assertSpecKeys, buildFromSpec } = require('../core/mintAdapters');
const { automationBlocker, hasSigningKey } = require('../core/automationPolicy');
const { ProviderError } = require('../core/errors');
const { txUrl, openSeaChainFor } = require('../chains');
const { isMintedOut, readMintedOut, mintedOutText } = require('../core/supply');
const { UserError, esc, shortAddr, parseEth, formatWei, parseWhen, utc, looksLikeSecret } = require('../util/format');
const { gasCap } = require('../core/gasPolicy');
const { feeFields } = require('../core/feePolicy');
const { POPULAR_ZONES, parseZone, formatWhen, describeZone, zoneLabel, localDate, localToUtc } = require('../util/timezone');
const thirdweb = require('../core/adapters/thirdweb');

// Six commands in the Telegram menu. Older names (/myschedules, /wallet, /plans, /premium, /referral,
// /ready, /preflight, /track, /check) still work as hidden shortcuts.
const COMMANDS = [
  { command: 'start', description: 'Start MintPilot' },
  { command: 'schedule', description: 'Schedule a mint' },
  { command: 'mints', description: 'Your scheduled mints' },
  { command: 'wallets', description: 'Your wallets and balances' },
  { command: 'dashboard', description: 'Open your dashboard' },
  { command: 'summary', description: 'Your mints at a glance' },
  { command: 'timezone', description: 'Set your time zone' },
  { command: 'support', description: 'Contact support' },
  { command: 'help', description: 'How MintPilot works' }
];


// ───────── conversation state ─────────
const getState = (db, id) => { const r = db.prepare('SELECT * FROM conversations WHERE telegram_id=?').get(String(id)); return r ? { state: r.state, data: JSON.parse(r.data) } : null; };
const setState = (db, id, state, data, now) => db.prepare('INSERT INTO conversations (telegram_id,state,data,updated_at) VALUES (?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET state=excluded.state,data=excluded.data,updated_at=excluded.updated_at').run(String(id), state, JSON.stringify(data), now);
const clearState = (db, id) => db.prepare('DELETE FROM conversations WHERE telegram_id=?').run(String(id));

const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// Where "Back" leads from each step of the /schedule wizard. Steps that depend on the chosen mint method return
// to the method list; the time and wallet steps return to "when should MintPilot mint".
const BACK_TO = {
  'sched.contract': 'chain', 'sched.collectionResults': 'contract', 'sched.preset': 'contract',
  'sched.qty': 'preset', 'sched.price': 'preset', 'sched.adapterConfig': 'preset', 'sched.osQty': 'contract', 'sched.osPrice': 'osQty', 'sched.twToken': 'preset', 'sched.seadropFee': 'preset', 'sched.mode': 'preset',
  'sched.when': 'mode', 'sched.launchAt': 'mode', 'sched.wallet': 'mode', 'sched.wallet1': 'mode', 'sched.confirm': 'mode'
};
/** The contract-inspection summary, shown above the mint-method choices. */
const inspectionIntro = (disc) => {
  if (!disc) return '';
  const supply = disc.totalSupply != null && disc.maxSupply != null ? `\nSupply: <b>${disc.totalSupply}</b> / ${disc.maxSupply}` : '';
  const proxy = disc.implementation ? `\nProxy implementation: <code>${disc.implementation}</code>` : '';
  return `<b>Contract inspection</b>\nCollection: <b>${esc(disc.name || 'Unknown')}</b> ${disc.symbol ? `<code>${esc(disc.symbol)}</code>` : ''}\nStandard: ${disc.standards?.erc721 ? 'ERC-721' : disc.standards?.erc1155 ? 'ERC-1155' : 'unconfirmed'}${supply}${proxy}\nVerified ABI: ${disc.verifiedAbi ? 'yes' : 'not available'}\nMint protocol: ${esc(disc.protocol || 'unknown')}\n\n`;
};
// Everything chosen after the contract; cleared when the user goes back to the method list.
const METHOD_FIELDS = ['preset', 'mintSpec', 'quantity', 'priceWei', 'seaDrop', 'thirdwebPhase', 'openSeaDrop', 'osSlug', 'osFeeBps', 'osSuggestedPriceWei', 'osCandidates', 'adapter', 'triggerMode', 'when', 'launchAt', 'endAt', 'wallets'];
/** Wizard keyboard: the step's own buttons, then Back (when there is a previous step) and Cancel. */
const nav = (state, rows = []) => kb([...rows, [...(BACK_TO[state] ? [{ text: '‹ Back', callback_data: `wz:b:${state}` }] : []), { text: 'Cancel', callback_data: 'wz:x' }]]);
const timePicks = (withNow, zoneName, zoneButton) => [
  [{ text: 'In 10 min', callback_data: 't:+10m' }, { text: 'In 1 hour', callback_data: 't:+1h' }],
  [{ text: 'In 6 hours', callback_data: 't:+6h' }, { text: `Tomorrow 18:00 ${zoneName}`, callback_data: 't:tom' }],
  ...(withNow ? [[{ text: 'It is already open', callback_data: 't:now' }]] : []),
  [zoneButton]
];

const MENU_BTN = { text: '‹ Menu', callback_data: 'm:home' };
/** A keyboard for a screen opened from the menu: its own rows, then the way home. */
const withMenu = (rows = []) => kb([...rows, [MENU_BTN]]);
const MINTS_PER_PAGE = 5;
const BALANCE_CHECK_MS = 4000; // the confirm screen never waits longer than this for a balance

function menu(extraTop = []) {
  return kb([
    ...extraTop,
    [{ text: 'Schedule a mint', callback_data: 'm:schedule' }],
    [{ text: 'My mints', callback_data: 'm:list' }, { text: 'Wallets', callback_data: 'm:wallets' }],
    [{ text: 'Dashboard', callback_data: 'm:dashboard' }, { text: 'Plan', callback_data: 'm:plan' }],
    [{ text: 'Time zone', callback_data: 'm:tz' }, { text: 'Help', callback_data: 'm:help' }]
  ]);
}

function createBotHandlers(ctx) {
  const { tg, db, cfg, chains, rpc, buildMintTx } = ctx;
  const now = ctx.now;
  const say = (chatId, text, extra) => tg.sendMessage(chatId, text, extra);
  // A button press edits the message it was tapped on, so a flow stays one card instead of a growing pile of
  // messages with stale buttons. Only the first screen() after a press edits. Errors and notices use say() and
  // therefore never replace the screen the user is looking at. One chat's updates run strictly one at a time
  // (see bot/poller.js), so a per-chat entry cannot be picked up by another update.
  const editing = new Map();
  const screen = async (chatId, text, extra) => {
    const mid = editing.get(chatId);
    if (mid == null) return tg.sendMessage(chatId, text, extra);
    editing.delete(chatId);
    try { return await tg.editMessageText(chatId, mid, text, extra); } catch (e) {
      if (/message is not modified/i.test(e?.description || e?.message || '')) return null;
      return tg.sendMessage(chatId, text, extra); // the message is too old or gone: fall back to a new one
    }
  };

  // The /schedule wizard lives in ONE message (its "pane") that is edited from step to step, whether the user
  // tapped a button or typed an answer. Typed answers are deleted once read, and mistakes appear as a notice at
  // the top of the pane, so the chat holds one card instead of a pile of prompts and replies.
  // The pane is remembered per chat in memory. After a restart it is forgotten and the next step sends a fresh one.
  const panes = new Map(); // chatId -> { mid, text, extra }
  const isNotModified = (e) => /message is not modified/i.test(e?.description || e?.message || '');
  const wiz = async (chatId, text, extra) => {
    const tapped = editing.get(chatId); editing.delete(chatId);
    let mid = tapped ?? panes.get(chatId)?.mid ?? null;
    if (mid != null) { try { await tg.editMessageText(chatId, mid, text, extra); } catch (e) { if (!isNotModified(e)) mid = null; } }
    if (mid == null) { const sent = await tg.sendMessage(chatId, text, extra); mid = sent?.message_id ?? null; }
    if (mid != null) {
      panes.set(chatId, { mid, text, extra });
      if (panes.size > 5000) panes.delete(panes.keys().next().value); // abandoned wizards must not accumulate
    }
  };
  /** A mistake or refusal: shown on top of the current screen, whose buttons stay. */
  const warn = async (chatId, html) => {
    const pane = panes.get(chatId); const tapped = editing.get(chatId); editing.delete(chatId);
    if (!pane || (tapped != null && tapped !== pane.mid)) return say(chatId, html);
    try { await tg.editMessageText(chatId, pane.mid, `⚠️ ${html}\n\n${pane.text}`, pane.extra); } catch (e) { if (!isNotModified(e)) return say(chatId, html); }
    return undefined;
  };
  /** The wizard is over: the pane becomes the final message. */
  const wizEnd = async (chatId, text, extra) => {
    const tapped = editing.get(chatId); editing.delete(chatId);
    const mid = tapped ?? panes.get(chatId)?.mid ?? null; panes.delete(chatId);
    if (mid != null) { try { await tg.editMessageText(chatId, mid, text, extra); return; } catch (e) { if (isNotModified(e)) return; } }
    await tg.sendMessage(chatId, text, extra);
  };
  /** The wizard was stopped by a command: close the pane so no stale buttons are left. Returns whether it did. */
  const abortPane = async (chatId, extra) => {
    const pane = panes.get(chatId); panes.delete(chatId);
    if (!pane) return false;
    try { await tg.editMessageText(chatId, pane.mid, `${pane.text}\n\n<i>Cancelled.</i>`, extra); return true; } catch { return false; }
  };
  const isAdmin = (id) => cfg.adminIds.includes(String(id));
  const isHttps = cfg.publicUrl.startsWith('https://');
  // /ready and /preflight on an OpenSea schedule each spend one OpenSea API write (the mint builder),
  // and all users share the server key. Allow one such check per schedule per minute.
  const OPENSEA_CHECK_COOLDOWN_SEC = 60;
  const openSeaChecks = new Map();
  function openSeaCheckBlocked(schedule) {
    let adapter = null;
    try { adapter = schedule.mint_spec ? JSON.parse(schedule.mint_spec).adapter : null; } catch { /* not OpenSea */ }
    if (adapter !== 'opensea-drop') return false;
    const t = now();
    for (const [id, at] of openSeaChecks) if (t - at >= OPENSEA_CHECK_COOLDOWN_SEC) openSeaChecks.delete(id);
    if (openSeaChecks.has(schedule.id)) return true;
    openSeaChecks.set(schedule.id, t);
    return false;
  }
  const deploymentBlocker = () => automationBlocker(cfg, chains, Object.keys(chains)[0]);
  const signableWallets = (telegramId) => listWallets(db, telegramId).filter(hasSigningKey);
  // An inline Merkle proof or mint signature is bound to one wallet; provider-backed specs fetch one per wallet.
  function adapterErrorText(e) {
    if (e instanceof UserError) return esc(e.message);
    if (e instanceof ProviderError) return esc(e.userMessage);
    if (e?.name === 'OpenSeaApiError') return esc(e.message);
    (ctx.log || console).error('adapter configuration check failed', e?.message);
    return 'That configuration could not be checked right now. Try again in a moment, or /cancel.';
  }
  const inlineEligibility = (spec) => Boolean(spec && !spec.providerId && ((spec.adapter === 'merkle' && spec.proof !== undefined) || (spec.adapter === 'signature' && spec.signature !== undefined)));
  // Example timestamps are built from the clock: a hardcoded date goes stale and is then rejected as "in the past".
  // A user's time zone (null = UTC) and times shown in it: "2027-01-15 18:10 UTC+1 (17:10 UTC)".
  const tzOf = (id) => getUser(db, id)?.timezone || null;
  const fmt = (ts, id) => formatWhen(ts, tzOf(id));
  const pad2 = (n) => String(n).padStart(2, '0');
  const tomorrow18 = (zone) => {
    const z = zone || 'UTC'; const t = localDate(z, now()); const next = new Date(Date.UTC(t.y, t.mo - 1, t.d + 1));
    return localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 18, 0, z);
  };
  const exampleWhen = (zone) => { const e = localDate(zone || 'UTC', tomorrow18(zone)); return `${e.y}-${pad2(e.mo)}-${pad2(e.d)} 18:00`; };
  const zoneLine = (id) => { const z = tzOf(id); return z ? `Times are in your time zone (<b>${zoneLabel(z, now())}</b>); add <code>utc</code> after a time to use UTC instead. It is now <b>${formatWhen(now(), z)}</b>.` : `Times are in UTC. It is now <b>${utc(now())}</b>.`; };
  const zoneButton = (id) => ({ text: tzOf(id) ? '🌍 Change time zone' : '🌍 Set my time zone', callback_data: 'tz:menu' });
  const pickLabel = (id) => zoneLabel(tzOf(id) || 'UTC', tomorrow18(tzOf(id)));
  /** " (in 2h 14m)" for a future time, "" otherwise. */
  const inText = (ts) => {
    const secs = ts - now();
    if (!(secs > 0)) return '';
    const d = Math.floor(secs / 86400); const h = Math.floor((secs % 86400) / 3600); const m = Math.floor((secs % 3600) / 60);
    const parts = [d && `${d}d`, h && `${h}h`, (m || (!d && !h)) && `${m}m`].filter(Boolean).slice(0, 2);
    return ` (in ${parts.join(' ')})`;
  };
  const chainName = (k) => (chains[k] ? chains[k].name : k);
  const networkList = () => Object.values(chains).map((c) => c.name).join(', ');
  const ensureUserWallet = async (id) => {
    try { return await ensurePlatformWalletAsync(db, cfg, id, now()); }
    catch (e) { (ctx.log || console).error(`platform wallet provisioning failed for ${id}: ${e.message}`); return null; }
  };

  // ───────── commands ─────────
  async function cmdStart(chatId, from, payload, isNew) {
    if (isNew && payload && payload.startsWith('ref_')) { await ensureUserWallet(from.id); registerReferral(db, from.id, payload.slice(4), now()); }
    return homeScreen(chatId, from);
  }

  /** The home screen: /start sends it, the "‹ Menu" button brings any screen back to it in place. */
  async function homeScreen(chatId, from) {
    const platformWallet = await ensureUserWallet(from.id);
    await screen(chatId,
      `<b>Welcome to MintPilot</b>\nSchedule an NFT mint and MintPilot signs and sends it for you.\n\n<b>Your wallet</b>\n${platformWallet ? `<code>${platformWallet.address}</code>` : 'Your wallet is not ready yet. Please try again in a moment.'}\nThis wallet is custodial: MintPilot holds its encrypted key, so only add funds you can afford to lose.\n\n<b>To start</b>\n1. Send ETH to this address on the network you want to mint on\n2. Tap <b>Schedule a mint</b>\n\n🔒 Never send a private key or recovery phrase in Telegram.`, menu());
  }

  async function cmdHelp(chatId) {
    await screen(chatId, `<b>How MintPilot works</b>\nYou schedule a mint and MintPilot signs and sends it automatically from your wallet. There is nothing for you to sign.\n\n<b>Commands</b>\n/schedule — set up a mint\n/mints — see, check or cancel your mints\n/wallets — your address and balances\n/dashboard — a private view of your activity on the web\n/summary — your mints at a glance\n/support — talk to us\n/cancel — stop the current setup\n\n<b>Before a mint</b>\nKeep enough ETH in your wallet for the mint price plus network fees, on the network you chose.\n\n<b>Networks</b>: ${esc(networkList())}\n\nAdvanced: /track &lt;network&gt; &lt;txHash&gt; follows a transaction, and /check &lt;address&gt; looks an address up in the allowlist file.\n\n🔒 Never send a private key or recovery phrase in Telegram.`, menu([[{ text: 'Contact support', callback_data: 'm:support' }]]));
  }


  async function cmdWalletPortal(chatId, from, mode = 'menu') {
    if (mode === 'menu') return cmdWallets(chatId, from);
    const u = getUser(db, from.id);
    if (planOf(u, now()) !== 'premium') return screen(chatId, 'Adding wallets is a Premium feature. Tap <b>Plan</b> in the menu to upgrade.', menu());
    const sid = createLinkSession(db, { telegramId: from.id, domain: new URL(cfg.publicUrl).host, ttlSec: 600 }, now());
    const url = `${cfg.publicUrl}/import?s=${sid}&mode=${mode}`;
    const text = '<b>Add a wallet</b>\nOpen the private page below. Never paste a private key or recovery phrase into Telegram.\n\nMintPilot stores the wallet\'s key encrypted so it can sign your scheduled mints. Use a dedicated wallet, not one holding valuable funds. The ownership check is free and sends no transaction.';
    const back = [{ text: '‹ Wallets', callback_data: 'm:wallets' }, MENU_BTN];
    return isHttps ? screen(chatId, text, kb([[{ text: mode === 'create' ? 'Create wallet' : 'Import wallet', url }], back])) : screen(chatId, `${text}\n\n${esc(url)}`, kb([back]));
  }

  async function cmdWallets(chatId, from) {
    await ensureUserWallet(from.id);
    const ws = listWallets(db, from.id);
    if (!ws.length) return screen(chatId, 'Your wallet is not ready yet. Send /start and try again in a moment.', withMenu());
    // Balances take a moment: show that something is happening (and drop the buttons) while they load.
    const tappedMid = editing.get(chatId);
    const loading = tappedMid != null ? tg.editMessageText(chatId, tappedMid, '⏳ Loading your wallets…').catch(() => {}) : null;
    const keys = Object.keys(chains);
    // Every wallet × every network in parallel; each lookup is bounded by RPC_TIMEOUT_MS and fails alone.
    const balances = await Promise.all(ws.map((w) => (typeof rpc.getBalances === 'function'
      ? rpc.getBalances(w.address, keys)
      : Promise.all(keys.map((k) => rpc.getBalance(k, w.address).catch(() => null))).then((v) => Object.fromEntries(keys.map((k, i) => [k, v[i]]))))));
    const blocks = ws.map((w, i) => {
      const b = balances[i];
      const funded = keys.filter((k) => b[k] != null && BigInt(b[k]) > 0n).map((k) => `  ${esc(chainName(k))}: <b>${formatWei(b[k])} ${esc(chains[k].currency)}</b>`);
      const failed = keys.filter((k) => b[k] == null).map(chainName);
      if (failed.length) (ctx.log || console).warn?.('balance lookup failed', { wallet: shortAddr(w.address), chains: failed });
      const kind = w.wallet_type === 'platform' ? 'Main wallet · custodial' : hasSigningKey(w) ? 'Added wallet · custodial' : 'Signature-only wallet · cannot be auto-signed';
      return `• ${kind}\n  <code>${w.address}</code>\n${funded.length ? funded.join('\n') : '  No ETH on any supported network yet.'}${failed.length ? `\n  <i>Balance unavailable right now on: ${esc(failed.join(', '))}</i>` : ''}`;
    });
    const premium = planOf(getUser(db, from.id), now()) === 'premium';
    const limit = cfg.plans.premium.wallets;
    const removeRows = ws.filter((w) => w.wallet_type !== 'platform').map((w) => [{ text: `🗑 Remove ${shortAddr(w.address)}`, callback_data: `rm:${w.id}` }]);
    const addRows = premium
      ? (ws.length < limit ? [[{ text: 'Create new wallet', callback_data: 'm:wallet-create' }, { text: 'Import wallet', callback_data: 'm:wallet-import' }]] : [])
      : [[{ text: 'Add more wallets with Premium', callback_data: 'm:plan' }]];
    await loading;
    await screen(chatId, `<b>Your wallets</b>\nOne address works on every supported network: ${esc(networkList())}.\n\n` + blocks.join('\n\n') + `\n\nThe main wallet cannot be removed. Removing another wallet cancels its pending mints.${premium ? '' : `\nPremium lets you hold up to ${limit} wallets.`}`,
      withMenu([...removeRows, ...addRows]));
  }

  const scheduleWhen = (r, id) => (r.trigger_mode === 'launch'
    ? `As soon as it opens${r.launch_at ? ` (expected ${fmt(r.launch_at, id)})` : ''}`
    : `${fmt(r.scheduled_at, id)}${['scheduled', 'ready'].includes(r.status) ? inText(r.scheduled_at) : ''}`);

  async function cmdMySchedules(chatId, from, requestedPage = 0) {
    const all = listSchedules(db, from.id, 50);
    if (!all.length) return screen(chatId, 'No mints scheduled yet. Tap <b>Schedule a mint</b> or send /schedule.', menu());
    const pages = Math.ceil(all.length / MINTS_PER_PAGE);
    const page = Math.min(Math.max(Number.isInteger(requestedPage) ? requestedPage : 0, 0), pages - 1);
    const rows = all.slice(page * MINTS_PER_PAGE, (page + 1) * MINTS_PER_PAGE);
    const statusLabel = { scheduled: 'Scheduled', ready: 'Test run passed', submitted: 'Sent', confirmed: 'Confirmed', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired' };
    const blocks = rows.map((r) => `<b>Mint #${r.id}</b> · ${statusLabel[r.status] || esc(r.status)}\nNetwork: ${esc(chainName(r.chain))}\nWhen: ${scheduleWhen(r, from.id)}\nPrice: ${formatWei(r.total_wei)} ETH per wallet, plus network fee${r.quantity > 1 ? `\nQuantity: ${r.quantity}` : ''}\nNFT contract: <code>${r.contract}</code>${r.last_error ? `\nLast status: ${esc(r.last_error)}` : ''}`);
    const parts = [''];
    if (pages > 1) blocks.unshift(`<i>Page ${page + 1} of ${pages}</i>`);
    for (const b of blocks) { const cur = parts.length - 1; if (parts[cur] && parts[cur].length + b.length + 2 > 3800) parts.push(b); else parts[cur] = parts[cur] ? `${parts[cur]}\n\n${b}` : b; }
    const buttons = rows.filter((r) => ['scheduled', 'ready'].includes(r.status)).flatMap((r) => [[{ text: `Check · #${r.id}`, callback_data: `r:${r.id}` }, { text: `Cancel · #${r.id}`, callback_data: `x:${r.id}` }]]);
    const pager = pages > 1 ? [[...(page > 0 ? [{ text: '‹ Newer', callback_data: `m:list:${page - 1}` }] : []), ...(page < pages - 1 ? [{ text: 'Older ›', callback_data: `m:list:${page + 1}` }] : [])]] : [];
    for (let i = 0; i < parts.length; i += 1) await (i === 0 ? screen : say)(chatId, parts[i], i === parts.length - 1 ? withMenu([...buttons, ...pager]) : undefined);
  }

  async function cmdReady(chatId, from, args) {
    const id = Number(args[0]);
    const schedule = Number.isInteger(id) && id > 0 ? getSchedule(db, id) : null;
    if (!schedule || String(schedule.telegram_id) !== String(from.id)) return say(chatId, 'Usage: <code>/ready &lt;scheduleId&gt;</code>\nThe schedule must belong to you.');
    if (!['scheduled', 'ready'].includes(schedule.status)) return say(chatId, `Schedule #${id} is already ${esc(schedule.status)} and cannot be preflighted.`);
    if (typeof buildMintTx !== 'function') return say(chatId, 'Readiness checks are unavailable because the mint adapter is not connected.');
    if (openSeaCheckBlocked(schedule)) return say(chatId, `OpenSea checks are limited to one per schedule per minute. Try again shortly.`);
    let r;
    try { r = await checkMintReadiness({ schedule, cfg, chains, rpc, buildMintTx, db }); } catch (e) {
      (ctx.log || console).error(`readiness check failed for schedule ${id}: ${e.message}`);
      return say(chatId, 'The check could not complete right now. Try again in a moment.');
    }
    const checkLines = r.checks.map((c) => `${c.ok === true ? '✅' : c.ok === false ? '❌' : 'ℹ️'} ${esc(c.detail)}`).join('\n');
    const verdict = r.ready ? '✅ <b>Ready to mint</b>' : '⚠️ <b>Not ready yet</b>';
    return say(chatId, `<b>Check · mint #${id}</b>\n${verdict}\n\n${checkLines}\n\nWallet: <code>${r.wallet}</code>\nContract: <code>${r.contract}</code>\n\nThe allowlist file is only a guide: the NFT contract has the final say.`);
  }

  async function cmdPreflight(chatId, from, args) {
    const id = Number(args[0]);
    const schedule = Number.isInteger(id) && id > 0 ? getSchedule(db, id) : null;
    if (!schedule || String(schedule.telegram_id) !== String(from.id)) return say(chatId, 'Usage: <code>/preflight &lt;scheduleId&gt;</code>\nThe schedule must belong to you.');
    if (!['scheduled', 'ready'].includes(schedule.status)) return say(chatId, `Schedule #${id} is already ${esc(schedule.status)} and cannot be preflighted.`);
    if (typeof buildMintTx !== 'function') return say(chatId, 'Preflight is unavailable because the mint adapter is not connected.');
    if (openSeaCheckBlocked(schedule)) return say(chatId, `OpenSea checks are limited to one per schedule per minute. Try again shortly.`);
    try {
      const r = await runPreflight({ schedule, cfg, chains, rpc, buildMintTx, db, now: now() });
      const checkLines = r.checks.map((c, i) => `${i + 1}. ${c.ok === true ? '✅' : c.ok === false ? '❌' : 'ℹ️'} <b>${esc(c.name)}</b> — ${esc(c.detail)}`).join('\n');
      const verdict = r.ready ? '✅ <b>READY — exact transaction preflight passed</b>' : '⚠️ <b>NOT READY — do not submit yet</b>';
      return say(chatId, `<b>Launch preflight · schedule #${id}</b>\nWallet: <code>${esc(r.wallet)}</code>\nNetwork: <b>${esc(chainName(r.chain))}</b>\nContract: <code>${esc(r.contract)}</code>\n\n${verdict}\n\n${checkLines}\n\nThis command is read-only. It does not sign, send, or reserve a transaction. MintPilot runs these checks again automatically at launch, immediately before signing.`);
    } catch (e) {
      (ctx.log || console).error(`preflight failed for schedule ${id}: ${e.message}`);
      return say(chatId, `Preflight could not complete safely: ${esc(e.message)}`);
    }
  }

  async function cmdDashboard(chatId, from) {
    const sid = createDashboardSession(db, { telegramId: from.id, ttlSec: 3600, now: now() });
    const url = `${cfg.publicUrl}/dashboard?s=${sid}`;
    const text = '<b>Your MintPilot dashboard</b>\nView your wallets, mint schedules, and transaction status. This private link is view-only and expires in 1 hour.';
    return isHttps ? screen(chatId, text, withMenu([[{ text: 'Open dashboard', url }]])) : screen(chatId, `${text}\n\n${esc(url)}`, withMenu());
  }

  async function cmdTrack(chatId, from, args) {
    const [chainKey, hash] = args;
    if (!chainKey || !hash || !chains[chainKey] || !HASH_RE.test(hash)) {
      return say(chatId, `Usage: <code>/track &lt;network&gt; &lt;txHash&gt;</code>\nNetworks: ${Object.keys(chains).join(', ')}`);
    }
    try {
      const r = addTrackedTx(db, cfg, { telegramId: from.id, chain: chainKey, txHash: hash }, now());
      await say(chatId, r.duplicate ? 'Already tracking that transaction.' : `🔎 Tracking on ${esc(chainName(chainKey))}. I'll message you when it confirms.\n${esc(txUrl(chains[chainKey], hash))}`);
    } catch (e) { if (e instanceof TrackError) return say(chatId, esc(e.message)); throw e; }
  }

  async function cmdCheck(chatId, args) {
    if (args.length !== 1) return say(chatId, 'Usage: <code>/check &lt;walletAddress&gt;</code>');
    try {
      let loaded = null;
      try { loaded = loadEligibilityFile(cfg.eligibilityFile); } catch { loaded = null; }
      if (loaded && loaded.size === 0) return say(chatId, 'No allowlist is loaded on this bot, so there is nothing to check an address against. Ask the project for its official allowlist checker.');
      const result = checkEligibility(args[0], cfg.eligibilityFile);
      return say(chatId, result.listed
        ? `✅ <code>${result.address}</code> is eligible to mint according to the current allowlist file.`
        : `❌ <code>${result.address}</code> is not listed in the current allowlist file, so it is not eligible according to this file.`);
    } catch (e) {
      if (e instanceof UserError || /Eligibility file/.test(e.message)) return say(chatId, esc(e.message));
      throw e;
    }
  }

  function retiredOption(chatId) {
    return screen(chatId, 'That option is no longer available. MintPilot now uses your <b>platform wallet</b>: see it with /wallets, or use the menu to schedule a mint.', menu());
  }

  function planText(from) {
    const u = getUser(db, from.id); const t = now();
    const f = cfg.plans.free; const p = cfg.plans.premium;
    const additional = Math.max(0, p.wallets - 1);
    return `<b>Plans</b>\n\n<b>Free</b>\n• ${f.activeSchedules} active schedules\n• ${f.wallets} platform wallet\n• ${f.pendingTxs} tracked pending txs\n• Reminder at mint time\n\n<b>Premium</b> — ${cfg.premium.priceStars} ⭐ / ${cfg.premium.days} days\n• ${p.activeSchedules} active schedules\n• ${p.wallets} total wallets (1 platform + ${additional} additional)\n• ${p.pendingTxs} tracked pending txs\n• Pre-mint alerts 10 min and 1 min before start\n\nYou: <b>${planOf(u, t)}</b>${u.premium_until > t ? (isPermanentPremium(u.premium_until) ? ' (no expiry)' : ` (until ${fmt(u.premium_until, from.id)})`) : ''}`;
  }
  async function cmdPlans(chatId, from) { await screen(chatId, planText(from), withMenu()); }

  // The menu's Plan button: plan details, upgrade button and the invite link on one screen.
  async function cmdPlan(chatId, from) {
    const u = getUser(db, from.id);
    const premium = planOf(u, now()) === 'premium';
    const link = `https://t.me/${ctx.botUsername}?start=ref_${u.ref_code}`;
    await screen(chatId, `${planText(from)}\n\n<b>Invite friends</b>\nYou get <b>${cfg.referral.referrerDays} days</b> of Premium when a friend you invite links a wallet with some on-chain history.\n<code>${link}</code>`,
      withMenu([[{ text: premium ? `Add ${cfg.premium.days} more days · ${cfg.premium.priceStars} ⭐` : `Get Premium · ${cfg.premium.priceStars} ⭐`, callback_data: 'm:upgrade' }], [{ text: 'Invite friends', callback_data: 'm:referral' }]]));
  }


  async function cmdSummary(chatId, from) {
    const t = now(); const weekAgo = t - 7 * 86400;
    const one = (sql, ...p) => db.prepare(sql).get(from.id, ...p);
    const all = one("SELECT COUNT(*) n, COALESCE(SUM(quantity), 0) nfts FROM schedules WHERE telegram_id=? AND status='confirmed'");
    const week = one("SELECT COUNT(*) n FROM schedules WHERE telegram_id=? AND status='confirmed' AND scheduled_at>?", weekAgo);
    const missed = one("SELECT COUNT(*) n FROM schedules WHERE telegram_id=? AND status IN ('failed','expired') AND scheduled_at>?", weekAgo);
    const next = one("SELECT COUNT(*) n, MIN(scheduled_at) next_at FROM schedules WHERE telegram_id=? AND status IN ('scheduled','ready')");
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    await screen(chatId, `📊 <b>Your MintPilot summary</b>\n\n<b>Last 7 days</b>\n✅ ${plural(week.n, 'mint')} confirmed\n${missed.n ? `⚠️ ${plural(missed.n, 'mint')} did not go through\n` : ''}\n<b>All time</b>\n🎯 ${plural(all.n, 'mint')} · ${plural(all.nfts, 'NFT')}\n\n<b>Coming up</b>\n${next.n ? `⏳ ${plural(next.n, 'mint')} scheduled, the next one on ${fmt(next.next_at, from.id)}` : 'Nothing scheduled yet. Tap Schedule a mint to set one up.'}`, withMenu([[{ text: 'My mints', callback_data: 'm:list' }]]));
  }

  async function cmdPremium(chatId, from) {
    await say(chatId, planText(from));
    await tg.sendInvoice(chatId, invoiceFor(cfg, from.id));
  }

  async function cmdReferral(chatId, from) {
    const u = getUser(db, from.id); const s = referralStats(db, from.id);
    const link = `https://t.me/${ctx.botUsername}?start=ref_${u.ref_code}`;
    await screen(chatId, `<b>Invite friends</b>\nYou get <b>${cfg.referral.referrerDays} days</b> of Premium and your friend gets <b>${cfg.referral.refereeDays} day${cfg.referral.refereeDays === 1 ? '' : 's'}</b> when they link a wallet with some on-chain history. Max ${cfg.referral.maxRewards} rewarded referrals.\n\n<code>${link}</code>\n\nRewarded: ${s.rewarded} · Pending: ${s.pending}`, withMenu());
  }

  async function cmdGrant(chatId, from, args) {
    if (!isAdmin(from.id)) return;
    const [id, days] = args;
    if (!/^\d+$/.test(id || '') || !/^\d{1,4}$/.test(days || '') || !getUser(db, id)) return say(chatId, 'Usage: /grant &lt;telegramId&gt; &lt;days&gt; (user must have started the bot)');
    const until = extendPremium(db, id, Number(days), now());
    await say(chatId, `Granted. Premium until ${utc(until)}.`);
    tg.sendMessage(id, `⭐ You've been granted ${days} days of Premium.`).catch(() => {});
  }
  async function cmdRevoke(chatId, from, args) {
    if (!isAdmin(from.id)) return;
    if (!/^\d+$/.test(args[0] || '') || !getUser(db, args[0])) return say(chatId, 'Usage: /revoke &lt;telegramId&gt;');
    if (isAdmin(args[0])) return say(chatId, 'Admins always have Premium. To remove it, take that ID out of ADMIN_TELEGRAM_IDS first.');
    revokePremium(db, args[0]);
    await say(chatId, 'Premium revoked.');
  }
  async function cmdStats(chatId, from) {
    if (!isAdmin(from.id)) return;
    const t = now();
    const c = (sql, ...p) => db.prepare(sql).get(...p).n;
    await say(chatId, `Users: ${c('SELECT COUNT(*) n FROM users')}\nPremium: ${c('SELECT COUNT(*) n FROM users WHERE premium_until>?', t)}\nWallets: ${c('SELECT COUNT(*) n FROM wallets')}\nActive schedules: ${c("SELECT COUNT(*) n FROM schedules WHERE status IN ('scheduled','ready')")}\nStars received: ${c('SELECT COALESCE(SUM(amount),0) n FROM payments')}`);
  }


  // ───────── support & admin tools ─────────
  const ANNOUNCE_MAX = 3000;
  const adminTextOf = (raw) => String(raw || '').replace(/^\/\w+(?:@\w+)?\s*/, '').trim();

  async function cmdSupport(chatId, from) {
    if (!cfg.adminIds.length) return say(chatId, 'Support is not set up on this bot yet. Please try again later.', menu());
    setState(db, from.id, 'support.msg', {}, now());
    return say(chatId, '💬 <b>Contact support</b>\nTell us what you need in one message: what you were doing, what went wrong, and the mint number (like #3) if it is about a schedule.\n\n🔒 Never include a private key or recovery phrase.\nSend /cancel to stop.');
  }
  async function sendSupportMessage(chatId, from, text) {
    const body = text.trim();
    if (body.length < 5) return warn(chatId, 'Please add a few more details so we can help.');
    if (body.length > 1500) return warn(chatId, 'That is a bit long. Please keep it under 1500 characters.');
    clearState(db, from.id);
    const who = from.username ? `@${esc(from.username)}` : esc([from.first_name, from.last_name].filter(Boolean).join(' ') || 'a user');
    await Promise.all(cfg.adminIds.map((id) => tg.sendMessage(id, `📩 <b>Support message</b>\nFrom ${who} (<code>${from.id}</code>)\n\n${esc(body)}\n\nReply with: <code>/reply ${from.id} your message</code>`).catch(() => {})));
    return say(chatId, '✅ Thanks! We have your message and will reply here as soon as we can.', menu());
  }
  async function cmdReply(chatId, from, raw) {
    if (!isAdmin(from.id)) return;
    const m = adminTextOf(raw).match(/^(\d+)\s+([\s\S]+)$/);
    if (!m || !getUser(db, m[1])) return say(chatId, 'Usage: /reply &lt;telegramId&gt; &lt;message&gt; (the user must have started the bot)');
    try {
      await tg.sendMessage(m[1], `💬 <b>MintPilot support</b>\n${esc(m[2].slice(0, 3000))}`);
      return say(chatId, '✅ Sent.');
    } catch { return say(chatId, 'Could not deliver that message. The user may have blocked the bot.'); }
  }
  async function cmdAnnounce(chatId, from, raw) {
    if (!isAdmin(from.id)) return;
    const text = adminTextOf(raw);
    if (!text) return say(chatId, 'Usage: /announce &lt;message&gt;\nI will show you a preview and ask before sending it to every user. The message is sent as plain text.');
    if (text.length > ANNOUNCE_MAX) return say(chatId, `That is too long. Keep announcements under ${ANNOUNCE_MAX} characters.`);
    const n = db.prepare('SELECT COUNT(*) n FROM users WHERE blocked_bot=0 AND banned=0').get().n;
    setState(db, from.id, 'admin.announce', { text }, now());
    return say(chatId, `📣 <b>Preview</b>\n\n${announcementBody(text)}\n\nSend this to <b>${n}</b> user${n === 1 ? '' : 's'}?`,
      kb([[{ text: `Send to ${n}`, callback_data: 'ann:send' }, { text: 'Cancel', callback_data: 'ann:no' }]]));
  }
  const announcementBody = (text) => `📣 <b>MintPilot update</b>\n\n${esc(text)}`;
  async function sendAnnouncement(chatId, text) {
    const rows = db.prepare('SELECT telegram_id FROM users WHERE blocked_bot=0 AND banned=0').all();
    await say(chatId, `Sending to ${rows.length} user${rows.length === 1 ? '' : 's'}…`);
    let sent = 0; let failed = 0;
    for (const r of rows) {
      try { await tg.sendMessage(r.telegram_id, announcementBody(text)); sent += 1; }
      catch (e) { failed += 1; if (e?.blocked) db.prepare('UPDATE users SET blocked_bot=1 WHERE telegram_id=?').run(r.telegram_id); }
    }
    return say(chatId, `✅ Announcement sent to ${sent} user${sent === 1 ? '' : 's'}${failed ? ` (${failed} could not be reached)` : ''}.`);
  }
  async function cmdHealth(chatId, from) {
    if (!isAdmin(from.id)) return;
    const t = now();
    const c = (sql, ...p) => db.prepare(sql).get(...p).n;
    let version = '?';
    try { version = require('../../package.json').version; } catch { /* optional */ }
    const a = cfg.automation;
    const mode = !a.enabled ? 'automation off' : (a.dryRun ? '🧪 dry-run (nothing is signed)' : '🔴 LIVE signing');
    const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
    const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    const storage = onRailway ? (volume ? `✅ Railway volume at <code>${esc(volume)}</code>` : '⚠️ <b>No Railway volume detected</b>: data is lost on every redeploy') : 'local disk';
    const warnings = [];
    if (!cfg.openSeaApiKey) warnings.push('OPENSEA_API_KEY is not set, so OpenSea mints and lookups are off.');
    if (!a.encryptionKey) warnings.push('AUTOMATION_MASTER_KEY is missing, so wallets cannot be signed.');
    if (onRailway && cfg.trustProxyHops !== 1) warnings.push(`TRUST_PROXY_HOPS is ${cfg.trustProxyHops}; on Railway it should be 1.`);
    if (onRailway && cfg.clientIpHeader) warnings.push('CLIENT_IP_HEADER is set; on Railway leave it empty.');
    const single = Object.values(chains).filter((x) => x.rpcUrls.length < 2).map((x) => x.key);
    if (single.length) warnings.push(`Only one RPC on: ${single.join(', ')}.`);
    const up = Math.floor(process.uptime());
    const uptime = up >= 3600 ? `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m` : `${Math.floor(up / 60)}m ${up % 60}s`;
    await say(chatId, `<b>MintPilot health</b> · v${esc(version)}\nUptime: ${uptime}\nMode: ${mode}\nStorage: ${storage}\n\nUsers: ${c('SELECT COUNT(*) n FROM users')} (${c('SELECT COUNT(*) n FROM users WHERE premium_until>?', t)} premium)\nWallets: ${c('SELECT COUNT(*) n FROM wallets')}\nActive schedules: ${c("SELECT COUNT(*) n FROM schedules WHERE status IN ('scheduled','ready')")}\nLast 24h: ${c("SELECT COUNT(*) n FROM schedules WHERE status='confirmed' AND scheduled_at>?", t - 86400)} confirmed, ${c("SELECT COUNT(*) n FROM schedules WHERE status='failed' AND scheduled_at>?", t - 86400)} failed\nOpenSea API: ${cfg.openSeaApiKey ? '✅ configured' : '❌ not set'}${warnings.length ? `\n\n⚠️ <b>Needs attention</b>\n${warnings.map((w) => `• ${esc(w)}`).join('\n')}` : '\n\n✅ No configuration warnings.'}`);
  }

  // ───────── /schedule wizard ─────────
  async function startSchedule(chatId, from) {
    const usable = Object.values(chains).filter((c) => !automationBlocker(cfg, chains, c.key));
    if (!usable.length) return say(chatId, `Automatic minting is not available on this deployment right now. ${esc(deploymentBlocker() || '')}`.trim());
    if (!signableWallets(from.id).length) return say(chatId, 'Your wallet is not ready yet. Send /start and try again in a moment.');
    setState(db, from.id, 'sched.chain', {}, now());
    const rows = chunk(usable.map((c) => ({ text: c.name, callback_data: `c:${c.key}` })), 2);
    // A fresh run gets a fresh pane. If another wizard message is still open elsewhere, close it first.
    const open = panes.get(chatId);
    if (open && open.mid !== editing.get(chatId)) await abortPane(chatId); else panes.delete(chatId);
    await wiz(chatId, '<b>Schedule a mint</b>\nWhich network is the NFT on? You can stop any time with Cancel or /cancel.', nav('sched.chain', rows));
  }

  const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000';
  function openSeaInput(text) {
    const raw = String(text || '').trim();
    const address = raw.match(/0x[a-fA-F0-9]{40}/)?.[0];
    if (address && (raw === address || /^https?:\/\//i.test(raw))) return { address };
    if (/^https?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        if (!['opensea.io', 'www.opensea.io'].includes(url.hostname.toLowerCase())) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        const offset = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0] || '') ? 1 : 0;
        if (['collection', 'drops'].includes((parts[offset] || '').toLowerCase()) && parts[offset + 1]) {
          return { slug: parts[offset + 1] };
        }
      } catch { return null; }
      return null;
    }
    return { query: raw };
  }

  async function askContractPrompt(chatId, d) {
    setState(db, chatId, 'sched.contract', d, now());
    return wiz(chatId,
      `<b>Find the collection</b>\nSend its name to search on OpenSea, paste an OpenSea collection link, or enter the NFT contract address on ${esc(chainName(d.chain))}. MintPilot will check the match before you schedule.`,
      nav('sched.contract')
    );
  }

  function openSeaStagePrice(drop) {
    const stages = [drop.active_stage, drop.next_stage, ...(Array.isArray(drop.stages) ? drop.stages : [])].filter((stage) => {
      if (!stage) return false;
      const end = Date.parse(stage.end_time) / 1000;
      return !Number.isFinite(end) || end > now();
    });
    const stage = stages.find((x) => x.stage_type === 'public_sale' && /^\d+$/.test(String(x.price ?? ''))
      && String(x.price_currency_address || '').toLowerCase() === NATIVE_CURRENCY);
    return stage ? String(stage.price) : null;
  }

  async function askOpenSeaQuantity(chatId, d) {
    setState(db, chatId, 'sched.osQty', d, now());
    const max = Math.min(cfg.maxMintQuantity, 100);
    const picks = [1, 2, 3, 5, 10].filter((n) => n <= max);
    const rows = [picks.map((n) => ({ text: String(n), callback_data: `osq:${n}` }))];
    return wiz(chatId,
      `<b>${esc(d.openSeaDrop.collection_name || d.osSlug)}</b> · ${esc(chainName(d.chain))}\nContract: <code>${shortAddr(d.contract)}</code>\n\nHow many NFTs per wallet? Choose a button or type a number (1–${max}).`,
      nav('sched.osQty', rows)
    );
  }

  async function askOpenSeaPriceCap(chatId, d) {
    setState(db, chatId, 'sched.osPrice', d, now());
    const listed = /^\d+$/.test(String(d.osSuggestedPriceWei ?? '')) ? BigInt(d.osSuggestedPriceWei) : null;
    const rows = [];
    if (listed != null) rows.push([{ text: listed === 0n ? 'Use listed price (free)' : 'Use listed public price', callback_data: 'oscap:public' }]);
    rows.push([{ text: 'Free mint only (refuse any price)', callback_data: 'oscap:free' }]);
    const listedLine = listed == null
      ? 'No native-ETH public price was available to suggest; check the project’s mint page.'
      : (listed === 0n ? 'OpenSea lists this stage as <b>free</b>.' : `OpenSea lists a public price of ${formatWei(listed)} ETH per NFT when that public stage is active.`);
    return wiz(chatId,
      `<b>Maximum spend per NFT</b>\nType the highest price you would accept, in ETH (for example <code>0.05</code>). This is only a <b>ceiling</b>, not what you pay: if the mint is free you pay just the network fee, and your wallet does not need to hold the limit. MintPilot refuses any transaction above it.\n${listedLine}`,
      nav('sched.osPrice', rows)
    );
  }

  async function acceptOpenSeaPriceCap(chatId, d, priceWei) {
    if (priceWei * BigInt(d.quantity) > parseEth(cfg.maxMintValueEth)) {
      return warn(chatId, `That maximum totals ${formatWei(priceWei * BigInt(d.quantity))} ETH, above the bot’s safety limit of ${cfg.maxMintValueEth} ETH. Choose a lower limit or quantity.`);
    }
    d.preset = 'adapter:opensea-drop';
    d.priceWei = priceWei.toString();
    d.mintSpec = { adapter: 'opensea-drop', slug: d.osSlug, quantity: d.quantity, priceWei: d.priceWei, feeBps: d.osFeeBps };
    return askTriggerMode(chatId, d);
  }

  async function prepareOpenSeaCollection(chatId, d, slug, expectedContract = null) {
    tg.sendChatAction?.(chatId, 'typing')?.catch(() => {});
    if (!openSeaChainFor(d.chain)) return warn(chatId, `OpenSea collection lookup is not available on ${esc(chainName(d.chain))}.`);
    if (!cfg.openSeaApiKey) return warn(chatId, 'Collection lookup is not enabled on this bot yet. Enter the contract address to use the standard mint setup.');
    try {
      const drop = await getOpenSeaDrop(slug, { cfg });
      const contract = expectedContract || drop.contract_address;
      assertDropMatchesSchedule(drop, { chain: d.chain, contract }, slug);
      const pricedStages = [drop.active_stage, drop.next_stage].filter((stage) => stage?.stage_type === 'public_sale'
        && stage.price_currency_address && String(stage.price_currency_address).toLowerCase() !== NATIVE_CURRENCY);
      if (pricedStages.length) return warn(chatId, 'This collection’s current or next public sale uses a token other than ETH. MintPilot’s current maximum-spend setting is ETH-based, so this OpenSea route is not available for that stage.');
      if (!(await rpc.hasCode(d.chain, contract))) return warn(chatId, 'OpenSea returned a collection without a deployed contract on this network. Check the collection or choose another result.');
      const out = await readMintedOut(rpc, d.chain, contract);
      if (out) return warn(chatId, mintedOutText(esc(drop.collection_name || slug), out.minted, out.max));
      d.contract = contract;
      d.osSlug = drop.collection_slug;
      d.osFeeBps = drop.fee_bps;
      d.osSuggestedPriceWei = openSeaStagePrice(drop);
      d.preset = 'adapter:opensea-drop';
      d.openSeaDrop = {
        collection_name: drop.collection_name,
        collection_slug: drop.collection_slug,
        chain: drop.chain,
        drop_type: drop.drop_type,
        is_minting: drop.is_minting,
        active_stage: drop.active_stage,
        next_stage: drop.next_stage
      };
      return askOpenSeaQuantity(chatId, d);
    } catch (e) {
      return warn(chatId, adapterErrorText(e));
    }
  }

  async function resolveOpenSeaInput(chatId, from, d, input) {
    if (!input || (!input.slug && !input.address && !input.query)) return warn(chatId, 'Send a collection name, an OpenSea collection link, or a contract address.');
    if (input.slug) return prepareOpenSeaCollection(chatId, d, input.slug, d.contract || null);
    if (input.address) {
      if (!openSeaChainFor(d.chain)) return warn(chatId, `OpenSea lookup is not available on ${esc(chainName(d.chain))}.`);
      try {
        const match = await getOpenSeaCollectionByContract(input.address, { chain: d.chain, cfg });
        return prepareOpenSeaCollection(chatId, d, match.slug, input.address);
      } catch (e) { return warn(chatId, adapterErrorText(e)); }
    }
    if (input.query.length < 2 || input.query.length > 100) return warn(chatId, 'Search with at least 2 characters (maximum 100).');
    if (!cfg.openSeaApiKey) return warn(chatId, 'Collection search is not enabled on this bot yet. You can still enter the NFT contract address to use the standard mint setup.');
    try {
      const results = await searchOpenSeaCollections(input.query, { chain: d.chain, limit: 8, cfg });
      if (!results.length) return warn(chatId, `No collections found for “${esc(input.query)}” on ${esc(chainName(d.chain))}. Check the spelling, or choose “I have a contract address”.`);
      d.osCandidates = results;
      setState(db, from.id, 'sched.collectionResults', d, now());
      const rows = results.map((result, index) => [{ text: `${result.name.slice(0, 39)} · ${result.slug.slice(0, 18)}`, callback_data: `osr:${index}` }]);
      return wiz(chatId, `<b>Choose your collection</b>\nSearch results for “${esc(input.query)}” on ${esc(chainName(d.chain))}. Check the name before continuing; MintPilot verifies each selected contract.`, nav('sched.collectionResults', rows));
    } catch (e) { return warn(chatId, adapterErrorText(e)); }
  }

  async function askPreset(chatId) {
    const st = getState(db, chatId);
    const discovery = st?.data?.discovery;
    const intro = inspectionIntro(discovery);
    if (discovery?.protocol === 'seadrop') {
      const drops = (discovery.seaDrop || []).map((x, i) => {
        const d = x.publicDrop; const nowSec = x.now;
        const phase = nowSec < d.startTime ? `starts ${fmt(d.startTime, chatId)}` : nowSec <= d.endTime ? 'LIVE' : 'ended';
        return [{ text: `SeaDrop ${i + 1} · ${phase} · ${formatWei(BigInt(d.mintPrice))} ETH`, callback_data: `sd:${i}` }];
      });
      drops.push([{ text: 'Mint through OpenSea', callback_data: 'a:opensea-drop' }]);
      if (drops.length === 1) return wiz(chatId, intro + '<b>SeaDrop detected</b>\nNo readable public drop is configured on the authorized SeaDrop routers. You can still use OpenSea REST for an eligible SeaDrop V1 stage.', nav('sched.preset', drops));
      return wiz(chatId, intro + '<b>SeaDrop public drop detected</b>\nChoose the router/drop configuration to inspect and schedule. MintPilot will use the live on-chain price, time window, wallet cap, and fee rules.', nav('sched.preset', drops));
    }
    if (discovery?.protocol === 'thirdweb-drop' && discovery.thirdwebDrop) {
      const tw = discovery.thirdwebDrop;
      if (tw.needsTokenId) {
        return wiz(chatId, intro + '<b>thirdweb ERC-1155 drop detected</b>\nEach token ID has its own claim phases. Choose how to continue:', nav('sched.preset', [
          [{ text: 'thirdweb claim · enter token ID', callback_data: 'tw1155' }],
          [{ text: 'Other mint methods', callback_data: 'tw:other' }]
        ]));
      }
      return askThirdwebPhase(chatId, tw);
    }
    const essentialIds = new Set(['mint()', 'mint(uint256)', 'publicMint(uint256)']);
    const available = (discovery?.verifiedAbi && discovery.mintMethods?.length
      ? PRESETS.filter((p) => discovery.mintMethods.includes(p.id))
      : PRESETS).filter((p) => essentialIds.has(p.id));
    if (discovery?.verifiedAbi && !available.length) {
      return wiz(chatId, intro + 'The verified ABI does not expose a supported public mint method. MintPilot will not guess calldata for this contract.', nav('sched.preset'));
    }
    const detected = discovery?.mintMethods?.length ? `\nDetected verified methods: <code>${discovery.mintMethods.join('</code>, <code>')}</code>` : '';
    const protocol = discovery?.protocol ? `\nDetected protocol: <b>${esc(discovery.protocol)}</b>` : '';
    const menuLabels = { 'mint()': 'Standard mint', 'mint(uint256)': 'Mint quantity', 'publicMint(uint256)': 'Public mint' };
    const rows = chunk(available.map((p) => ({ text: menuLabels[p.id] || p.label, callback_data: `p:${PRESETS.indexOf(p)}` })), 2);
    rows.push([{ text: 'Merkle / allowlist mint', callback_data: 'a:merkle' }, { text: 'Signature-gated mint', callback_data: 'a:signature' }]);
    rows.push([{ text: 'SeaDrop signed mint', callback_data: 'a:seadrop-signed' }]);
    rows.push([{ text: 'Mint through OpenSea', callback_data: 'a:opensea-drop' }]);
    rows.push([{ text: 'Token-gated mint', callback_data: 'a:token' }]);
    await wiz(chatId, intro + `Choose the mint method supported by the collection.${protocol}${detected}\n\nUse the project's official mint instructions if you are unsure; do not guess. MintPilot only offers supported methods and checks the transaction before signing.`, nav('sched.preset', rows));
  }

  /** thirdweb phases as buttons. Allowlist and ERC-20 phases are listed but refused when chosen. */
  async function askThirdwebPhase(chatId, tw) {
    const nowSec = now();
    const intro = inspectionIntro(getState(db, chatId)?.data?.discovery);
    const current = thirdweb.phaseAt(tw.phases, nowSec);
    const rows = tw.phases.map((p) => {
      const when = p.startTimestamp > nowSec ? `starts ${fmt(p.startTimestamp, chatId)}` : (current && current.id === p.id ? 'LIVE' : 'past');
      const kind = p.allowlist ? 'allowlist' : (p.nativePrice ? `${formatWei(BigInt(p.pricePerToken))} ETH` : 'ERC-20 price');
      return [{ text: `Phase ${p.id} · ${when} · ${kind}`, callback_data: `tw:${p.id}` }];
    }).filter((row) => !row[0].text.includes('· past ·'));
    rows.push([{ text: 'Other mint methods', callback_data: 'tw:other' }]);
    const tokenLine = tw.tokenId != null ? `\nToken ID: <b>${esc(tw.tokenId)}</b>` : '';
    return wiz(chatId, intro + `<b>thirdweb drop detected</b> (${tw.standard === 'erc1155' ? 'ERC-1155' : 'ERC-721'}, ${esc(tw.variant)})${tokenLine}\nChoose the claim phase to schedule. MintPilot uses the phase's on-chain price, start time and wallet limit, and refuses the mint if the creator changes the price.`, nav('sched.preset', rows));
  }

  async function askOtherMethods(chatId, d) {
    d.discovery = { ...(d.discovery || {}), protocol: 'unknown', thirdwebDrop: null, seaDrop: null };
    setState(db, chatId, 'sched.preset', d, now());
    return askPreset(chatId);
  }

  async function askAdapterConfig(chatId, adapter) {
    if (adapter === 'opensea-drop') {
      const state = getState(db, chatId);
      if (!state?.data?.contract) return askContractPrompt(chatId, state?.data || {});
      return resolveOpenSeaInput(chatId, { id: chatId }, state.data, { address: state.data.contract });
    }
    const examples = {
      merkle: '{"signatureFunction":"mint(uint256,bytes32[])","quantity":1,"priceWei":"0","proof":["0x..."]}  — or "providerId":"<operator provider>" instead of "proof"',
      signature: '{"mintFunction":"mint(address,uint256,uint256,uint256,uint256,bytes)","quantity":1,"maxQuantity":1,"nonce":0,"deadline":1790000000,"signature":"0x...","priceWei":"0"}  — or "providerId":"<operator provider>" instead of the signature fields',
      token: '{"mintFunction":"mint(uint256)","quantity":1,"priceWei":"0","gateContract":"0x...","standard":"erc721","minBalance":1}',
      'seadrop-signed': '{"providerId":"<operator provider>","seaDropContract":"0x00005EA00Ac477B1030CE78506496e8C2dE24bf5","feeRecipient":"0x...","quantity":1}',
    };
    const state = getState(db, chatId);
    setState(db, chatId, 'sched.adapterConfig', { ...state.data, adapter }, now());
    const guidance = 'Send one JSON object with the exact contract function and eligibility fields. The function must be one of MintPilot’s explicitly supported signatures. Only the fields shown are accepted; eligibility data from elsewhere must come from a provider the operator configured (providerId).';
    return wiz(chatId, `<b>${esc(adapter)} mint adapter</b>\n${guidance}\nExample:\n<code>${esc(examples[adapter])}</code>`, nav('sched.adapterConfig'));
  }

  async function askPrice(chatId, d) {
    const p = byId(d.preset);
    await wiz(chatId, p.usesQuantity ? 'Price <b>per NFT</b> in ETH (e.g. <code>0.01</code>, or <code>0</code> for free mints):' : 'Total mint price in ETH (e.g. <code>0.01</code>, or <code>0</code> if free):', nav('sched.price'));
  }

  async function askTriggerMode(chatId, d) {
    setState(db, chatId, 'sched.mode', d, now());
    await wiz(chatId, '<b>When should MintPilot mint?</b>\n\n<b>At a set time</b> — MintPilot signs and sends the mint at the time you choose.\n<b>As soon as it opens</b> — MintPilot waits for the mint to open, keeps retrying while it is closed, and sends it the moment it works.', nav('sched.mode', [
      [{ text: 'At a set time', callback_data: 'mode:manual' }],
      [{ text: 'As soon as it opens', callback_data: 'mode:launch' }]
    ]));
  }

  async function afterWhen(chatId, from, d) {
    const ws = signableWallets(from.id);
    if (!ws.length) { clearState(db, from.id); return wizEnd(chatId, 'You have no wallet with a signing key on MintPilot.'); }
    if (inlineEligibility(d.mintSpec)) {
      // An inline proof/signature only works for the wallet it was issued to.
      d.wallets = [ws[0].address];
      if (ws.length > 1) {
        setState(db, from.id, 'sched.wallet1', d, now());
        return wiz(chatId, 'An inline proof or signature is valid for one wallet only. Choose the wallet it was issued for:', nav('sched.wallet1', ws.map((w) => [{ text: shortAddr(w.address), callback_data: `w1:${w.id}` }])));
      }
      return askConfirm(chatId, from, d);
    }
    if (ws.length > 1) {
      d.wallets = [];
      setState(db, from.id, 'sched.wallet', d, now());
      return wiz(chatId, 'Select every wallet to use. MintPilot creates one schedule per selected wallet; the quantity you entered applies to each wallet.', nav('sched.wallet', [...ws.map((w) => [{ text: `⬜ ${shortAddr(w.address)}`, callback_data: `w:${w.id}` }]), [{ text: 'Done', callback_data: 'w:done' }]]));
    }
    d.wallets = [ws[0].address];
    await askConfirm(chatId, from, d);
  }

  /**
   * Does each chosen wallet hold what the launch engine will require when it pre-signs: the mint total plus a
   * gas reserve (gas cap x max fee, with the armed fee headroom)? Only gas actually used is charged; the reserve
   * is what must be held. Only informs: the schedule can still be saved and funded later. A lookup that fails or
   * is slow is left out, and without fee data the check falls back to the mint total alone.
   */
  // When an OpenSea stage is already open, ask OpenSea for the mint transaction (nothing is signed or sent) so a wallet
  // that is not on the allowlist is flagged before the user confirms. Results are cached briefly to spare the shared API quota.
  const eligibilityProbes = new Map();
  const ELIGIBILITY_PROBE_TTL_SEC = 60;
  async function openSeaEligibilityNote(d) {
    if (d.preset !== 'adapter:opensea-drop' || !cfg.openSeaApiKey || !d.openSeaDrop?.is_minting || !d.openSeaDrop?.active_stage || !d.wallets?.length) return '';
    const t = now();
    for (const [k, v] of eligibilityProbes) if (t - v.at >= ELIGIBILITY_PROBE_TTL_SEC) eligibilityProbes.delete(k);
    const notListed = [];
    for (const wallet of d.wallets.slice(0, 3)) {
      const key = `${d.osSlug}:${wallet.toLowerCase()}:${d.quantity}`;
      let hit = eligibilityProbes.get(key);
      if (!hit) {
        hit = { at: t, notListed: false };
        try { await buildOpenSeaMintTransaction(d.osSlug, { cfg, minter: wallet, quantity: d.quantity }); }
        catch (e) {
          hit.notListed = e?.name === 'OpenSeaApiError' && (e.apiCode === 'MINTER_NOT_ELIGIBLE' || (e.status === 422 && /allow ?list|not eligible|not on the/i.test(String(e.message))));
        }
        eligibilityProbes.set(key, hit);
      }
      if (hit.notListed) notListed.push(wallet);
    }
    if (!notListed.length) return '';
    return `\n\n⚠️ <b>Not on the allowlist</b>\n${notListed.map((w) => `• <code>${w}</code>`).join('\n')}\nThis stage is open now and OpenSea says ${notListed.length === 1 ? 'this wallet is' : 'these wallets are'} not eligible, so the mint would fail. Choose a different wallet, or only confirm if you expect to be added before the mint.`;
  }

  async function balanceCheck(d, total, zeroLabel = 'free mint') {
    const limitMs = ctx.balanceCheckMs ?? BALANCE_CHECK_MS;
    const withLimit = (fn) => {
      let timer;
      return Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), limitMs); })]).finally(() => clearTimeout(timer));
    };
    const reserveLookup = withLimit(() => rpc.getFeeInputs(d.chain))
      .then((inputs) => gasCap(cfg, Number(d.quantity) || 1, d.chain) * feeFields(chains[d.chain], cfg, inputs, cfg.launch.armedFeeMultiplierBps).maxCost)
      .catch(() => null);
    const found = await Promise.all(d.wallets.map((addr) => withLimit(() => rpc.getBalance(d.chain, addr)).then((v) => ({ addr, bal: BigInt(v) })).catch(() => null)));
    const reserve = await reserveLookup;
    const known = found.filter(Boolean);
    if (!known.length) return { note: '', short: false };
    const cur = esc(chains[d.chain]?.currency || 'ETH');
    const needed = total + (reserve ?? 0n);
    const low = known.filter((r) => r.bal === 0n || r.bal < needed);
    const reserveNote = reserve == null ? null : `up to ${formatWei(reserve)} ${cur} gas reserve; only the gas actually used is charged`;
    if (!low.length) {
      if (reserve == null) {
        return { short: false, note: known.length === 1
          ? `\nBalance: <b>${formatWei(known[0].bal)} ${cur}</b> ✅ covers the mint total. Keep a little extra for the network fee.`
          : `\n✅ Every wallet holds at least the mint total. Keep a little extra for the network fee.` };
      }
      return { short: false, note: known.length === 1
        ? `\nBalance: <b>${formatWei(known[0].bal)} ${cur}</b> ✅ covers the mint total and the gas reserve (${reserveNote}).`
        : `\n✅ Every wallet covers the mint total and the gas reserve (${reserveNote}).` };
    }
    const need = reserve == null
      ? (total > 0n ? `at least <b>${formatWei(total)} ${cur}</b> plus the network fee` : 'a little ETH for the network fee')
      : `about <b>${formatWei(needed)} ${cur}</b> (${total > 0n ? `${formatWei(total)} mint` : zeroLabel} + ${reserveNote})`;
    return { short: true, note: `\n\n⚠️ <b>Not enough ${cur} on ${esc(chainName(d.chain))}</b>\n${low.map((r) => `• <code>${r.addr}</code> has <b>${formatWei(r.bal)} ${cur}</b>, needs ${need}`).join('\n')}\nAdd funds before the mint time. You can still save this schedule and fund it afterwards.` };
  }

  async function askConfirm(chatId, from, d) {
    setState(db, from.id, 'sched.confirm', d, now());
    const isOpenSeaDrop = d.preset === 'adapter:opensea-drop';
    const isThirdweb = d.preset === 'adapter:thirdweb-drop';
    const p = isOpenSeaDrop ? { label: 'Mint through OpenSea', usesQuantity: true } : (d.preset === 'seadrop' ? { label: 'SeaDrop public mint', usesQuantity: true } : (isThirdweb ? { label: `thirdweb claim (${d.mintSpec.standard === 'erc1155' ? 'ERC-1155' : 'ERC-721'})`, usesQuantity: true } : (d.preset?.startsWith('adapter:') ? { label: `${d.mintSpec.adapter} eligibility mint`, usesQuantity: true } : byId(d.preset))));
    const total = d.preset === 'seadrop' ? BigInt(d.mintSpec.mintPrice) * BigInt(d.quantity) : (d.preset?.startsWith('adapter:') ? BigInt(d.priceWei) * BigInt(d.quantity) : totalWei(d.preset, BigInt(d.priceWei), d.quantity));
    // For OpenSea the typed number is only a ceiling. Check funds against the listed price (or the fee alone when no price is listed).
    const listedPrice = isOpenSeaDrop && /^\d+$/.test(String(d.osSuggestedPriceWei ?? '')) ? BigInt(d.osSuggestedPriceWei) : null;
    const fundsTotal = isOpenSeaDrop ? (listedPrice == null ? 0n : listedPrice * BigInt(d.quantity)) : total;
    const balance = await balanceCheck(d, fundsTotal, isOpenSeaDrop ? 'price set by OpenSea at mint time' : 'free mint');
    const priceNote = !isOpenSeaDrop ? ''
      : (listedPrice === 0n ? '\n💚 OpenSea lists this stage as free, so you only pay the network fee. Your limit is just a ceiling.'
        : (listedPrice == null ? '\nℹ️ The exact price is read from OpenSea at mint time and never goes above your limit. Funds are checked against the network fee here.' : ''));
    const eligibility = await openSeaEligibilityNote(d);
    const automationNote = cfg.automation.dryRun
      ? '🧪 This deployment is in dry-run mode: at mint time MintPilot runs every check and reports what it would send, without signing anything.'
      : '🤖 MintPilot signs and sends this mint automatically from each selected wallet, after simulating it. You do not need to sign anything.';
    const routeDetails = isThirdweb ? `thirdweb phase: <b>${esc(String(d.mintSpec.phaseId))}</b>${d.mintSpec.tokenId != null ? ` · token ID <b>${esc(String(d.mintSpec.tokenId))}</b>` : ''}\nPrice per NFT: <b>${formatWei(BigInt(d.mintSpec.pricePerToken))} ETH</b> (exact, from the contract)\n` : isOpenSeaDrop ? `OpenSea collection: <code>${esc(d.mintSpec.slug)}</code>\n` : (d.preset === 'seadrop' ? `SeaDrop router: <code>${d.mintSpec.seaDropContract}</code>\nFee recipient: <code>${d.mintSpec.feeRecipient}</code>\n` : d.preset?.startsWith('adapter:') ? `Eligibility method: <code>${esc(d.mintSpec.adapter)}</code>\n` : '');
    const amountLabel = isOpenSeaDrop ? 'Price limit per wallet (a ceiling, not a charge)' : 'Mint total per wallet';
    await wiz(chatId, `<b>Confirm schedule</b> · Review before saving · ${d.wallets.length} wallet${d.wallets.length === 1 ? '' : 's'}\nNetwork: ${esc(chainName(d.chain))}\nNFT contract: <code>${d.contract}</code>\nMint method: ${esc(p.label)}${p.usesQuantity ? ` × ${d.quantity}` : ''}\n${routeDetails}${amountLabel}: <b>${formatWei(total)} ETH</b> (network fee not included)${isOpenSeaDrop ? '\nThe live API-built transaction may cost less, but MintPilot will refuse it if it exceeds this ceiling.' : ''}\nStart: <b>${d.triggerMode === 'launch' ? `As soon as it opens (expected ${fmt(d.launchAt, from.id)}${d.endAt ? `, window ends ${fmt(d.endAt, from.id)}` : ''})` : `At ${fmt(d.when, from.id)}${inText(d.when)}`}</b>\nWallets (${d.wallets.length}):\n${d.wallets.map((w) => `• <code>${w}</code>`).join('\n')}${balance.note}${priceNote}${eligibility}\n\n${automationNote} ⚠️ Check the contract address against the project's official source before confirming.`,
      kb([[{ text: 'Confirm schedule', callback_data: 'ok' }, { text: 'Cancel', callback_data: 'no' }], ...(balance.short ? [[{ text: '🔄 Check balance again', callback_data: 'cf:refresh' }]] : []), [{ text: '‹ Back', callback_data: 'wz:b:sched.confirm' }]]));
  }

  async function askLaunchAt(chatId, from, d) {
    setState(db, from.id, 'sched.launchAt', d, now());
    const z = tzOf(from.id);
    return wiz(chatId, `When does the mint open? Pick a time below or type one. ${zoneLine(from.id)}\nExamples: <code>5:10 pm</code> or <code>17:10</code> (the next time the clock shows it), <code>${exampleWhen(z)}</code>, <code>+2h</code>, or <code>now</code> if it is already open.`, nav('sched.launchAt', timePicks(true, pickLabel(from.id), zoneButton(from.id))));
  }
  async function askWhen(chatId, from, d) {
    setState(db, from.id, 'sched.when', d, now());
    const z = tzOf(from.id);
    return wiz(chatId, `Enter when MintPilot should sign and send the mint, or pick a time below. ${zoneLine(from.id)}\nExamples: <code>5:10 pm</code> or <code>17:10</code> (the next time the clock shows it), <code>${exampleWhen(z)}</code>, or <code>+5m</code> (five minutes from now, rounded down to a whole minute).`, nav('sched.when', timePicks(false, pickLabel(from.id), zoneButton(from.id))));
  }

  // ───────── time zone ─────────
  const TIME_STEPS = ['sched.when', 'sched.launchAt'];
  async function tzPicker(chatId, from) {
    const z = tzOf(from.id);
    const inStep = TIME_STEPS.includes(getState(db, from.id)?.state);
    const rows = chunk(POPULAR_ZONES.map(([name, label]) => ({ text: `${(z || 'UTC') === name ? '✓ ' : ''}${label}`, callback_data: `tz:${name}` })), 3);
    rows.push([inStep ? { text: '‹ Back to the schedule', callback_data: 'tz:back' } : MENU_BTN]);
    const text = `<b>Time zone</b>\nYours: <b>${esc(describeZone(z, now()))}</b>${z ? '' : ' (the default)'}\n\nTimes you type are read in this zone, and mint times are shown in both your zone and UTC. Add <code>utc</code> after a time to use UTC for just that time.\n\nPick yours below, or send <code>/timezone Africa/Lagos</code> or an offset like <code>/timezone UTC+1</code>.`;
    return (inStep ? wiz : screen)(chatId, text, kb(rows));
  }
  async function resumeTimeStep(chatId, from) {
    const st = getState(db, from.id);
    if (st?.state === 'sched.launchAt') return askLaunchAt(chatId, from, st.data);
    if (st?.state === 'sched.when') return askWhen(chatId, from, st.data);
    return undefined;
  }
  async function setZone(chatId, from, zone) {
    setUserTimezone(db, from.id, zone === 'UTC' ? null : zone);
    if (TIME_STEPS.includes(getState(db, from.id)?.state)) return resumeTimeStep(chatId, from);
    return screen(chatId, `✅ Time zone set to <b>${esc(describeZone(zone, now()))}</b>.\n\nTimes you type are now read in this zone, and mint times show both your zone and UTC. Add <code>utc</code> after a time to use UTC for just that time.`, withMenu([[{ text: 'Change it', callback_data: 'tz:menu' }]]));
  }
  async function cmdTimezone(chatId, from, args) {
    if (!args.length) return tzPicker(chatId, from);
    const zone = parseZone(args.join(' '));
    if (!zone) return say(chatId, 'I do not know that time zone. Pick a city with /timezone, or send a name like <code>/timezone Africa/Lagos</code> or an offset like <code>/timezone UTC+1</code>.');
    return setZone(chatId, from, zone);
  }
  async function tzCallback(chatId, from, arg) {
    if (arg === 'menu') return tzPicker(chatId, from);
    if (arg === 'back') return resumeTimeStep(chatId, from);
    const zone = parseZone(arg);
    return zone ? setZone(chatId, from, zone) : undefined;
  }

  // The chosen time arrives either typed or from a quick-pick button; both end up here.
  function applyLaunchAt(chatId, from, d, ts) { d.launchAt = ts; return afterWhen(chatId, from, d); }
  function applyWhen(chatId, from, d, ts) {
    d.when = ts;
    if (d.preset === 'seadrop' && d.when < d.seaDrop.publicDrop.startTime) return warn(chatId, `That time is before the SeaDrop phase opens at ${fmt(d.seaDrop.publicDrop.startTime, from.id)}. Choose a later time.`);
    if (d.preset === 'seadrop' && d.when > d.seaDrop.publicDrop.endTime) return warn(chatId, `That time is after the SeaDrop phase ends at ${fmt(d.seaDrop.publicDrop.endTime, from.id)}.`);
    return afterWhen(chatId, from, d);
  }

  /** "Back" re-asks the previous question. The contract and its inspection are kept when only the method changes. */
  async function wizardBack(chatId, from, st) {
    const d = st.data; const target = BACK_TO[st.state];
    if (target === 'chain') return startSchedule(chatId, from);
    if (target === 'osQty') return askOpenSeaQuantity(chatId, d);
    if (target === 'contract') {
      delete d.contract; delete d.discovery;
      return askContractPrompt(chatId, d);
    }
    if (target === 'preset') {
      for (const k of METHOD_FIELDS) delete d[k];
      setState(db, from.id, 'sched.preset', d, now());
      return askPreset(chatId);
    }
    for (const k of ['when', 'launchAt', 'endAt', 'wallets']) delete d[k];
    return askTriggerMode(chatId, d);
  }

  async function wizardText(chatId, from, st, text) {
    const d = st.data;
    try {
      switch (st.state) {
        case 'sched.osQty': {
          const max = Math.min(cfg.maxMintQuantity, 100);
          const quantity = Number(text.trim());
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) return warn(chatId, `Choose a whole number from 1 to ${max}.`);
          d.quantity = quantity;
          return askOpenSeaPriceCap(chatId, d);
        }
        case 'support.msg': return sendSupportMessage(chatId, from, text);
        case 'sched.osPrice': {
          const priceWei = parseEth(text.trim().replace(/\s*eth$/i, ''));
          return acceptOpenSeaPriceCap(chatId, d, priceWei);
        }
        case 'sched.seadropFee': {
          const recipient = normalizeAddress(text);
          if (d.seaDrop.publicDrop.restrictFeeRecipients && !d.seaDrop.allowedFeeRecipients.some((x) => x.toLowerCase() === recipient.toLowerCase())) return warn(chatId, 'That fee recipient is not in the SeaDrop allowlist. Choose one of the buttons or verify the address.');
          d.mintSpec.feeRecipient = recipient;
          setState(db, from.id, 'sched.qty', d, now());
          return wiz(chatId, `Public price: <b>${formatWei(BigInt(d.mintSpec.mintPrice))} ETH</b>\nWallet limit: <b>${d.seaDrop.publicDrop.maxTotalMintableByWallet}</b>\nEnter quantity (1–${cfg.maxMintQuantity}):`, nav('sched.qty'));
        }
        case 'sched.contract': {
          const raw = text.trim();
          const address = raw.match(/0x[a-fA-F0-9]{40}/)?.[0];
          if (!address) return resolveOpenSeaInput(chatId, from, d, openSeaInput(text));
          let addr;
          try { addr = normalizeAddress(address); } catch (e) { return warn(chatId, esc(e.message)); }
          let has;
          try { has = await rpc.hasCode(d.chain, addr); } catch { return warn(chatId, 'Could not reach that network right now. Try again in a moment.'); }
          if (!has) return warn(chatId, `No contract code at that address on ${esc(chainName(d.chain))}. Check the network and address.`);
          try {
            d.discovery = rpc.discover ? await rpc.discover(d.chain, addr) : null;
          } catch { d.discovery = null; }
          if (d.discovery && d.discovery.nft === false) return warn(chatId, 'That address does not identify itself as an ERC-721 or ERC-1155 NFT contract. Verify the collection address before continuing.');
          if (d.discovery && isMintedOut(d.discovery.totalSupply, d.discovery.maxSupply)) return warn(chatId, mintedOutText(esc(d.discovery.name || 'This collection'), d.discovery.totalSupply, d.discovery.maxSupply));
          d.contract = addr; setState(db, from.id, 'sched.preset', d, now());
          return askPreset(chatId);
        }
        case 'sched.adapterConfig': {
          // Migrate any OpenSea conversation persisted by v2.3.0 or earlier; never show its legacy JSON form.
          if (d.adapter === 'opensea-drop') return askContractPrompt(chatId, d);
          let spec;
          try { spec = JSON.parse(text); } catch { return warn(chatId, 'Send a valid JSON object. Use /cancel to restart.'); }
          if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return warn(chatId, 'Send a JSON object. Use /cancel to restart.');
          spec = { ...spec, adapter: d.adapter };
          try { assertSpecKeys(spec, 'user'); } catch (e) { return warn(chatId, adapterErrorText(e)); }
          const sampleWallet = signableWallets(from.id)[0]?.address;
          if (!sampleWallet) return warn(chatId, 'You need a wallet with a signing key before configuring an adapter.');
          try {
            // Validate against the first wallet now; provider-backed data is fetched again for each wallet at mint time.
            const sample = { contract: d.contract, wallet_address: sampleWallet, chain: d.chain, quantity: Number(spec.quantity), price_wei: spec.priceWei ?? '0' };
            const resolved = await resolveMintSpec(spec, sample, { now: now(), cfg });
            const built = buildFromSpec(resolved, sample);
            if (!Number.isInteger(Number(built.quantity)) || Number(built.quantity) < 1 || Number(built.quantity) > cfg.maxMintQuantity) return warn(chatId, `Quantity must be between 1 and ${cfg.maxMintQuantity}.`);
            if (BigInt(built.valueWei) > parseEth(cfg.maxMintValueEth)) return warn(chatId, `That total exceeds the safety cap of ${cfg.maxMintValueEth} ETH.`);
            d.preset = `adapter:${d.adapter}`;
            d.quantity = Number(built.quantity);
            if (d.adapter === 'seadrop-signed') {
              // Store the provider's live price: the stored total is the spend ceiling at mint time.
              const livePrice = String(resolved.mintParams.mintPrice);
              d.mintSpec = { ...spec, mintPrice: livePrice };
              d.priceWei = livePrice;
            } else {
              d.mintSpec = spec; // canonical user spec; provider data is never persisted
              d.priceWei = String(spec.priceWei ?? '0');
            }
            return askTriggerMode(chatId, d);
          } catch (e) { return warn(chatId, adapterErrorText(e)); }
        }
        case 'sched.twToken': {
          const raw = text.trim();
          if (!/^\d{1,78}$/.test(raw)) return warn(chatId, 'Send the token ID as a whole number (for example <code>0</code>), or /cancel.');
          let read;
          try { read = await thirdweb.readPhases((to, data) => rpc.ethCall(d.chain, to, data), d.contract, { standard: 'erc1155', tokenId: BigInt(raw) }); }
          catch { return warn(chatId, 'Could not read that token\'s claim phases right now. Try again in a moment.'); }
          if (!read || !read.phases.length) return warn(chatId, `Token ID ${esc(raw)} has no claim phases on this drop. Check the token ID on the project page.`);
          d.discovery.thirdwebDrop = { ...read, needsTokenId: false };
          setState(db, from.id, 'sched.preset', d, now());
          return askThirdwebPhase(chatId, d.discovery.thirdwebDrop);
        }
        case 'sched.qty': {
          const n = Number(text.trim());
          if (!Number.isInteger(n) || n < 1 || n > cfg.maxMintQuantity) return warn(chatId, `Enter a whole number from 1 to ${cfg.maxMintQuantity}.`);
          if (d.preset === 'adapter:thirdweb-drop') {
            const ph = d.thirdwebPhase;
            const limit = BigInt(ph.quantityLimitPerWallet);
            if (limit > 0n && BigInt(n) > limit) return warn(chatId, `This phase allows at most ${limit} per wallet.`);
            const remaining = BigInt(ph.maxClaimableSupply) - BigInt(ph.supplyClaimed);
            if (BigInt(n) > remaining) return warn(chatId, `Only ${remaining} remain in this phase.`);
            const total = BigInt(ph.pricePerToken) * BigInt(n);
            if (total > parseEth(cfg.maxMintValueEth)) return warn(chatId, `That total exceeds the safety cap of ${cfg.maxMintValueEth} ETH.`);
            d.quantity = n;
            d.mintSpec.quantity = n;
            d.priceWei = ph.pricePerToken;
            return askTriggerMode(chatId, d);
          }
          if (d.preset === 'seadrop' && d.seaDrop.publicDrop.maxTotalMintableByWallet > 0 && n > d.seaDrop.publicDrop.maxTotalMintableByWallet) return warn(chatId, `This public drop allows at most ${d.seaDrop.publicDrop.maxTotalMintableByWallet} per wallet.`);
          d.quantity = n;
          if (d.preset === 'seadrop') { d.priceWei = d.mintSpec.mintPrice; return askTriggerMode(chatId, d); }
          setState(db, from.id, 'sched.price', d, now());
          return askPrice(chatId, d);
        }
        case 'sched.price': {
          const wei = parseEth(text);
          if (totalWei(d.preset, wei, d.quantity) > parseEth(cfg.maxMintValueEth)) return warn(chatId, `That total exceeds the safety cap of ${cfg.maxMintValueEth} ETH.`);
          d.priceWei = wei.toString();
          return askTriggerMode(chatId, d);
        }
        case 'sched.launchAt': return applyLaunchAt(chatId, from, d, text.trim().toLowerCase() === 'now' ? now() : parseWhen(text, now(), tzOf(from.id) || 'UTC'));
        case 'sched.when': return applyWhen(chatId, from, d, parseWhen(text, now(), tzOf(from.id) || 'UTC'));
        default:
          return warn(chatId, 'Please use the buttons above, or /cancel to start over.');
      }
    } catch (e) {
      if (e instanceof UserError) return warn(chatId, esc(e.message));
      throw e;
    }
  }

  async function wizardCallback(chatId, from, st, data) {
    const d = st.data;
    if (data === 'wz:x') { clearState(db, from.id); return wizEnd(chatId, 'Cancelled. Tap <b>Schedule a mint</b> whenever you are ready.', menu()); }
    if (data.startsWith('wz:b:')) {
      // Back is tied to the step it was shown on, so an old button cannot move a wizard that has since advanced.
      if (data.slice(5) !== st.state || !BACK_TO[st.state]) return say(chatId, 'That menu has expired. Use /schedule to start again.');
      return wizardBack(chatId, from, st);
    }
    if (data === 'cf:refresh' && st.state === 'sched.confirm') return askConfirm(chatId, from, d);
    if ((st.state === 'sched.when' || st.state === 'sched.launchAt') && data.startsWith('t:')) {
      const pick = data.slice(2);
      if (!['+10m', '+1h', '+6h', 'tom', 'now'].includes(pick) || (pick === 'now' && st.state !== 'sched.launchAt')) return;
      const ts = pick === 'now' ? now() : pick === 'tom' ? tomorrow18(tzOf(from.id)) : parseWhen(pick, now());
      return st.state === 'sched.launchAt' ? applyLaunchAt(chatId, from, d, ts) : applyWhen(chatId, from, d, ts);
    }
    if (st.state === 'sched.mode' && data.startsWith('mode:')) {
      const mode = data.slice(5);
      if (!['manual', 'launch'].includes(mode)) return;
      d.triggerMode = mode;
      if (mode === 'launch') {
        d.when = now() + 1;
        d.launchAt = null;
        d.endAt = null;
        if (d.preset === 'seadrop') {
          d.launchAt = d.seaDrop.publicDrop.startTime;
          d.endAt = d.seaDrop.publicDrop.endTime;
        } else if (d.preset === 'adapter:thirdweb-drop') {
          // Launch time is the phase start read from the contract; the window closes when the next phase
          // starts (a new phase can change the price, and the claim would then be refused).
          const ph = d.thirdwebPhase;
          const next = (d.discovery?.thirdwebDrop?.phases || []).map((x) => x.startTimestamp).filter((t) => t > ph.startTimestamp).sort((x, y) => x - y)[0];
          d.launchAt = ph.startTimestamp;
          d.endAt = next || null;
        } else if (d.preset === 'adapter:opensea-drop') {
          const stage = d.openSeaDrop?.active_stage || d.openSeaDrop?.next_stage;
          const startAt = Date.parse(stage?.start_time) / 1000;
          const endAt = Date.parse(stage?.end_time) / 1000;
          if (!stage || !Number.isFinite(startAt) || !Number.isFinite(endAt)) return warn(chatId, 'OpenSea did not return a valid active or upcoming stage window. Choose a specific start time instead.');
          d.launchAt = Math.floor(startAt);
          d.endAt = Math.floor(endAt);
        } else {
          // Other contracts expose no standard opening time: the user supplies it. Until then (plus the
          // grace window) a reverting simulation means "not open yet" and is retried, not treated as final.
          return askLaunchAt(chatId, from, d);
        }
        return afterWhen(chatId, from, d);
      }
      return askWhen(chatId, from, d);
    }
    if (st.state === 'sched.collectionResults' && data.startsWith('osr:')) {
      const index = Number(data.slice(4));
      const result = d.osCandidates?.[index];
      if (!Number.isInteger(index) || !result) return warn(chatId, 'Those search results expired. Search for the collection again.');
      return prepareOpenSeaCollection(chatId, d, result.slug, d.contract || null);
    }
    if (st.state === 'sched.osQty' && data.startsWith('osq:')) {
      const quantity = Number(data.slice(4));
      const max = Math.min(cfg.maxMintQuantity, 100);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) return;
      d.quantity = quantity;
      return askOpenSeaPriceCap(chatId, d);
    }
    if (st.state === 'admin.announce' && (data === 'ann:send' || data === 'ann:no')) {
      clearState(db, from.id);
      if (!isAdmin(from.id)) return;
      return data === 'ann:send' ? sendAnnouncement(chatId, d.text) : say(chatId, 'Announcement cancelled.');
    }
    if (st.state === 'sched.osPrice' && data === 'oscap:free') return acceptOpenSeaPriceCap(chatId, d, 0n);
    if (st.state === 'sched.osPrice' && data === 'oscap:public' && /^\d+$/.test(String(d.osSuggestedPriceWei ?? ''))) {
      return acceptOpenSeaPriceCap(chatId, d, BigInt(d.osSuggestedPriceWei));
    }
    if (st.state === 'sched.chain' && data.startsWith('c:')) {
      const key = data.slice(2);
      if (!chains[key]) return;
      d.chain = key;
      return askContractPrompt(chatId, d);
    }
    if (st.state === 'sched.preset' && data === 'tw1155') {
      setState(db, from.id, 'sched.twToken', d, now());
      return wiz(chatId, 'Send the <b>token ID</b> to claim (the number shown on the project or OpenSea page for this edition):', nav('sched.twToken'));
    }
    if (st.state === 'sched.preset' && data === 'tw:other') return askOtherMethods(chatId, d);
    if (st.state === 'sched.preset' && data.startsWith('tw:')) {
      const tw = d.discovery?.thirdwebDrop;
      const ph = tw?.phases?.find((x) => String(x.id) === data.slice(3));
      if (!ph) return warn(chatId, 'That phase is no longer available. Start /schedule again.');
      const blocker = thirdweb.phaseBlocker(ph);
      if (blocker) return warn(chatId, `${esc(blocker)}\nChoose another phase or "Other mint methods".`);
      if (BigInt(ph.maxClaimableSupply) <= BigInt(ph.supplyClaimed)) return warn(chatId, 'That phase is sold out.');
      d.preset = 'adapter:thirdweb-drop';
      d.thirdwebPhase = ph;
      d.mintSpec = { adapter: 'thirdweb-drop', standard: tw.standard, ...(tw.standard === 'erc1155' ? { tokenId: String(tw.tokenId) } : {}), quantity: 1, pricePerToken: ph.pricePerToken, currency: thirdweb.NATIVE, phaseId: ph.id };
      setState(db, from.id, 'sched.qty', d, now());
      const limit = BigInt(ph.quantityLimitPerWallet);
      return wiz(chatId, `Phase ${ph.id} price: <b>${formatWei(BigInt(ph.pricePerToken))} ETH</b> per NFT\nWallet limit: <b>${limit > 0n ? limit : 'none'}</b> · Remaining: <b>${BigInt(ph.maxClaimableSupply) - BigInt(ph.supplyClaimed)}</b>\nEnter quantity (1–${cfg.maxMintQuantity}):`, nav('sched.qty'));
    }
    if (st.state === 'sched.preset' && data.startsWith('p:')) {
      const p = PRESETS[Number(data.slice(2))];
      if (!p) return;
      if (st.data.discovery?.verifiedAbi && !st.data.discovery.mintMethods.includes(p.id)) return warn(chatId, 'That method is not present in the verified contract ABI.');
      d.preset = p.id;
      if (p.usesQuantity) { setState(db, from.id, 'sched.qty', d, now()); return wiz(chatId, `How many to mint? (1–${cfg.maxMintQuantity})`, nav('sched.qty')); }
      d.quantity = 1; setState(db, from.id, 'sched.price', d, now());
      return askPrice(chatId, d);
    }
    if (st.state === 'sched.preset' && data.startsWith('a:')) {
      const adapter = data.slice(2);
      if (!['merkle', 'signature', 'token', 'seadrop-signed', 'opensea-drop'].includes(adapter)) return;
      return askAdapterConfig(chatId, adapter);
    }
    if (st.state === 'sched.preset' && data.startsWith('sd:')) {
      const discovery = d.discovery;
      const selected = discovery?.seaDrop?.[Number(data.slice(3))];
      if (!selected) return warn(chatId, 'That SeaDrop configuration is no longer available. Start /schedule again.');
      const drop = selected.publicDrop;
      if (selected.now > drop.endTime) return warn(chatId, 'That SeaDrop public phase has ended.');
      d.preset = 'seadrop';
      d.mintSpec = { adapter: 'seadrop', seaDropContract: selected.address, nftContract: d.contract, mintPrice: drop.mintPrice, feeBps: drop.feeBps, restrictFeeRecipients: drop.restrictFeeRecipients };
      d.seaDrop = selected;
      if ((drop.restrictFeeRecipients || drop.feeBps > 0) && selected.allowedFeeRecipients.length) {
        setState(db, from.id, 'sched.seadropFee', d, now());
        return wiz(chatId, `<b>SeaDrop fee recipient required</b>\nThis drop restricts fee recipients. Choose an allowlisted recipient:`, nav('sched.seadropFee', selected.allowedFeeRecipients.map((a) => [{ text: shortAddr(a), callback_data: `sdf:${a}` }])));
      }
      if (drop.restrictFeeRecipients || drop.feeBps > 0) { setState(db, from.id, 'sched.seadropFee', d, now()); return wiz(chatId, 'Send the SeaDrop fee-recipient address. It must be allowlisted when the drop restricts fee recipients.', nav('sched.seadropFee')); }
      d.mintSpec.feeRecipient = '0x0000000000000000000000000000000000000000';
      setState(db, from.id, 'sched.qty', d, now());
      return wiz(chatId, `Public price: <b>${formatWei(BigInt(drop.mintPrice))} ETH</b>\nWallet limit: <b>${drop.maxTotalMintableByWallet}</b>\nEnter quantity (1–${cfg.maxMintQuantity}):`, nav('sched.qty'));
    }
    if (st.state === 'sched.seadropFee' && data.startsWith('sdf:')) {
      d.mintSpec.feeRecipient = normalizeAddress(data.slice(4));
      setState(db, from.id, 'sched.qty', d, now());
      return wiz(chatId, `Public price: <b>${formatWei(BigInt(d.mintSpec.mintPrice))} ETH</b>\nWallet limit: <b>${d.seaDrop.publicDrop.maxTotalMintableByWallet}</b>\nEnter quantity (1–${cfg.maxMintQuantity}):`, nav('sched.qty'));
    }
    if (st.state === 'sched.wallet1' && data.startsWith('w1:')) {
      const w = signableWallets(from.id).find((x) => x.id === Number(data.slice(3)));
      if (!w) return warn(chatId, 'That wallet is unavailable. Use /schedule to start again.');
      d.wallets = [w.address];
      return askConfirm(chatId, from, d);
    }
    if (st.state === 'sched.wallet' && data.startsWith('w:')) {
      if (data === 'w:done') {
        if (!d.wallets?.length) return warn(chatId, 'Select at least one wallet first.');
        return askConfirm(chatId, from, d);
      }
      const w = signableWallets(from.id).find((x) => x.id === Number(data.slice(2)));
      if (!w) return;
      d.wallets = d.wallets || [];
      const index = d.wallets.findIndex((x) => x.toLowerCase() === w.address.toLowerCase());
      if (index >= 0) d.wallets.splice(index, 1); else d.wallets.push(w.address);
      setState(db, from.id, 'sched.wallet', d, now());
      const selected = new Set(d.wallets.map((x) => x.toLowerCase()));
      return wiz(chatId, `Selected ${d.wallets.length} wallet${d.wallets.length === 1 ? '' : 's'}.`, nav('sched.wallet', [...signableWallets(from.id).map((item) => [{ text: `${selected.has(item.address.toLowerCase()) ? '✅' : '⬜'} ${shortAddr(item.address)}`, callback_data: `w:${item.id}` }]), [{ text: '✅ Done', callback_data: 'w:done' }]]));
    }
    if (st.state === 'sched.confirm') {
      if (data === 'no') { clearState(db, from.id); return wizEnd(chatId, 'Aborted.', menu()); }
      if (data === 'ok') {
        try {
          const ids = createSchedules(db, cfg, chains, (d.wallets || []).map((wallet) => ({ telegramId: from.id, chain: d.chain, contract: d.contract, preset: d.preset, mintSpec: d.mintSpec, quantity: d.quantity, priceWei: BigInt(d.priceWei), scheduledAt: d.when, triggerMode: d.triggerMode, launchAt: d.launchAt, endAt: d.endAt || (d.preset === 'seadrop' ? d.seaDrop.publicDrop.endTime : null), wallet })), now());
          clearState(db, from.id);
          const action = cfg.automation.dryRun ? 'Test mode: MintPilot will run every check and tell you what it would send, without signing.' : 'MintPilot will sign and send it automatically and tell you the result.';
          const timing = d.triggerMode === 'launch' ? 'to send as soon as it opens' : `for ${fmt(d.when, from.id)}`;
          return wizEnd(chatId, ids.length === 1
            ? `✅ Mint <b>#${ids[0]}</b> scheduled ${timing}. ${action}`
            : `✅ ${ids.length} mints scheduled ${timing}: ${ids.map((id) => `<b>#${id}</b>`).join(', ')}. ${action}`,
          withMenu([[{ text: 'My mints', callback_data: 'm:list' }]]));
        } catch (e) {
          if (e instanceof ScheduleError) { clearState(db, from.id); return wizEnd(chatId, esc(e.message), menu()); }
          throw e;
        }
      }
    }
    return say(chatId, 'That menu has expired. Use /schedule to start again.');
  }

  // ───────── routing ─────────
  async function onCallback(q) {
    if (!q.message || q.message.chat.type !== 'private') return;
    const chatId = q.message.chat.id; const from = q.from;
    const data = String(q.data || '');
    // Confirming a cancellation answers the press itself, with a toast saying what happened.
    if (!data.startsWith('xy:')) await tg.answerCallbackQuery(q.id).catch(() => {});
    const { user } = upsertUser(db, { id: from.id, username: from.username }, now());
    if (isAdmin(from.id)) grantAdminPremium(db, [from.id]); // admins always have Premium, with no expiry
    if (user.banned) { if (data.startsWith('xy:')) await tg.answerCallbackQuery(q.id).catch(() => {}); return; }
    await ensureUserWallet(from.id);
    // Every button press edits the message it was tapped on: the chat stays one card, and "‹ Menu" brings it home.
    if (q.message.message_id != null) editing.set(chatId, q.message.message_id);
    try { return await routeCallback(chatId, from, data, q); } finally { editing.delete(chatId); }
  }

  async function routeCallback(chatId, from, data, q) {
    if (data.startsWith('m:list:')) return cmdMySchedules(chatId, from, Number(data.slice(7)));
    if (data.startsWith('m:')) {
      switch (data) {
        case 'm:home': return homeScreen(chatId, from);
        case 'm:tz': return tzPicker(chatId, from);
        case 'm:schedule': return startSchedule(chatId, from);
        case 'm:list': return cmdMySchedules(chatId, from);
        case 'm:wallets': case 'm:wallet': return cmdWallets(chatId, from);
        case 'm:dashboard': return cmdDashboard(chatId, from);
        case 'm:plan': return cmdPlan(chatId, from);
        case 'm:help': return cmdHelp(chatId);
        case 'm:upgrade': return tg.sendInvoice(chatId, invoiceFor(cfg, from.id));
        case 'm:wallet-create': return cmdWalletPortal(chatId, from, 'create');
        case 'm:wallet-import': return cmdWalletPortal(chatId, from, 'import');
        // Older buttons from messages sent before this version keep working.
        case 'm:connect': return retiredOption(chatId);
        case 'm:accounts': case 'm:deposit': case 'm:balances': case 'm:policies': return retiredOption(chatId);
        case 'm:track': return screen(chatId, 'Send: <code>/track &lt;network&gt; &lt;txHash&gt;</code>', withMenu());
        case 'm:premium': return cmdPremium(chatId, from);
        case 'm:referral': return cmdReferral(chatId, from);
        case 'm:plans': return cmdPlans(chatId, from);
        case 'm:support': return cmdSupport(chatId, from);
      }
      return;
    }
    if (data.startsWith('tz:')) return tzCallback(chatId, from, data.slice(3));
    if (data.startsWith('r:')) return cmdReady(chatId, from, [data.slice(2)]);
    if (data.startsWith('ac:') || data.startsWith('bal:') || data.startsWith('pol:')) return retiredOption(chatId);
    if (data.startsWith('x:')) {
      const id = Number(data.slice(2));
      const r = listSchedules(db, from.id, 50).find((x) => x.id === id && ['scheduled', 'ready'].includes(x.status));
      if (!r) return cmdMySchedules(chatId, from); // already signed or finished, or not yours: just show the current list
      return screen(chatId, `<b>Cancel mint #${id}?</b>\nNetwork: ${esc(chainName(r.chain))}\nNFT contract: <code>${r.contract}</code>\nWhen: ${scheduleWhen(r, from.id)}\n\nMintPilot will not sign or send it. You can schedule it again later, but a launch time may pass in the meantime.`,
        kb([[{ text: 'Yes, cancel it', callback_data: `xy:${id}` }, { text: 'Keep it', callback_data: 'm:list' }]]));
    }
    if (data.startsWith('xy:')) {
      const id = Number(data.slice(3));
      const ok = cancelSchedule(db, id, from.id);
      await tg.answerCallbackQuery(q.id, ok ? `Mint #${id} cancelled` : 'Could not cancel: it was already signed or finished, or it is not yours.').catch(() => {});
      return ok ? cmdMySchedules(chatId, from) : undefined; // refresh the list in place
    }
    if (data.startsWith('rm:')) {
      const w = listWallets(db, from.id).find((x) => x.id === Number(data.slice(3)) && x.wallet_type !== 'platform');
      if (!w) return say(chatId, 'Wallet not found.');
      return screen(chatId, `<b>Remove this wallet?</b>\n<code>${w.address}</code>\n\nMintPilot deletes its stored key and cancels its pending mints. This cannot be undone: move any funds out first.`,
        kb([[{ text: 'Yes, remove it', callback_data: `rmy:${w.id}` }, { text: 'Keep it', callback_data: 'rmn' }]]));
    }
    if (data === 'rmn') return screen(chatId, 'Okay, the wallet was kept.', kb([[{ text: 'Wallets', callback_data: 'm:wallets' }]]));
    if (data.startsWith('rmy:')) {
      return screen(chatId, removeWallet(db, from.id, Number(data.slice(4))) ? 'Wallet removed; its pending schedules were cancelled.' : 'Wallet not found.', kb([[{ text: 'Wallets', callback_data: 'm:wallets' }]]));
    }
    const st = getState(db, from.id);
    if (!st) return say(chatId, 'That menu has expired. Use /schedule to start again.');
    return wizardCallback(chatId, from, st, data);
  }

  async function onMessage(m) {
    if (m.chat.type !== 'private' || !m.from || m.from.is_bot) return;
    const chatId = m.chat.id; const from = m.from;
    const text = (m.text || '').trim();
    const { user, isNew } = upsertUser(db, { id: from.id, username: from.username }, now());
    if (isAdmin(from.id)) grantAdminPremium(db, [from.id]); // admins always have Premium, with no expiry
    if (user.banned) return;
    if (!ctx.limiter.allow(String(from.id))) return;
    await ensureUserWallet(from.id);

    const cmd = text.startsWith('/') ? text.match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/) : null;
    if (!cmd) {
      const secret = looksLikeSecret(text);
      if (secret) {
        await tg.deleteMessage(chatId, m.message_id).catch(() => {});
        await abortPane(chatId);
        clearState(db, from.id);
        return say(chatId, `🚨 <b>That looked like a ${secret === 'private_key' ? 'private key' : 'seed phrase'}.</b> I deleted it and did not store it, but Telegram chats are not safe for secrets.\n\nIf it was real, <b>treat that wallet as compromised</b>: move funds to a new wallet now. MintPilot will never ask for a seed phrase or private key in chat.`);
      }
    }
    if (cmd) {
      const name = cmd[1].toLowerCase(); const args = (cmd[2] || '').trim().split(/\s+/).filter(Boolean);
      if (name !== 'start') { /* commands other than /start abort any wizard */ if (name !== 'cancel') { await abortPane(chatId); clearState(db, from.id); } }
      switch (name) {
        case 'start': await abortPane(chatId); clearState(db, from.id); return cmdStart(chatId, from, args[0], isNew);
        case 'help': return cmdHelp(chatId);
        case 'connect': return retiredOption(chatId);
        case 'wallet': return cmdWalletPortal(chatId, from, 'menu');
        case 'wallets': return cmdWallets(chatId, from);
        case 'accounts': case 'deposit': case 'balances': case 'policies': return retiredOption(chatId);
        case 'policy': case 'pause': case 'resume': case 'status': return retiredOption(chatId);
        case 'schedule': return startSchedule(chatId, from);
        case 'ready': return cmdReady(chatId, from, args);
        case 'preflight': return cmdPreflight(chatId, from, args);
        case 'authorize': return retiredOption(chatId);
        case 'mints': case 'myschedules': return cmdMySchedules(chatId, from);
        case 'dashboard': return cmdDashboard(chatId, from);
        case 'timezone': case 'tz': return cmdTimezone(chatId, from, args);
        case 'track': return cmdTrack(chatId, from, args);
        case 'check': return cmdCheck(chatId, args);
        case 'plans': return cmdPlans(chatId, from);
        case 'premium': return cmdPremium(chatId, from);
        case 'referral': return cmdReferral(chatId, from);
        case 'grant': return cmdGrant(chatId, from, args);
        case 'revoke': return cmdRevoke(chatId, from, args);
        case 'stats': return cmdStats(chatId, from);
        case 'health': return cmdHealth(chatId, from);
        case 'announce': return cmdAnnounce(chatId, from, text);
        case 'reply': return cmdReply(chatId, from, text);
        case 'support': return cmdSupport(chatId, from);
        case 'summary': return cmdSummary(chatId, from);
        case 'cancel': { const had = getState(db, from.id); clearState(db, from.id); if (had && await abortPane(chatId, menu())) return undefined; return say(chatId, had ? 'Cancelled.' : 'Nothing to cancel.'); }
        default: return say(chatId, 'Unknown command. Try /help.');
      }
    }
    const st = getState(db, from.id);
    if (st) {
      try { return await wizardText(chatId, from, st, text); } finally {
        if (m.message_id != null) tg.deleteMessage(chatId, m.message_id).catch(() => {}); // the answer is read: keep the chat to the one pane
      }
    }
    return say(chatId, 'Use the menu or /help.', menu());
  }

  async function onPreCheckout(q) {
    const v = validatePreCheckout(db, cfg, q);
    await tg.answerPreCheckoutQuery(q.id, v.ok, v.error);
  }

  async function onPayment(m) {
    const r = recordPayment(db, cfg, m.from.id, m.successful_payment, now());
    if (r.granted) return say(m.chat.id, `⭐ <b>Premium activated</b> until ${fmt(r.premiumUntil, m.chat.id)}. Thank you!`);
    if (r.reason === 'duplicate') return;
    (ctx.log || console).error('payment mismatch', m.from.id, m.successful_payment.telegram_payment_charge_id);
    await say(m.chat.id, `We received your payment but could not activate Premium automatically. Please contact support with this reference: <code>${esc(m.successful_payment.telegram_payment_charge_id)}</code>`);
  }

  async function handleUpdate(u) {
    if (u.pre_checkout_query) return onPreCheckout(u.pre_checkout_query);
    if (u.callback_query) return onCallback(u.callback_query);
    if (u.message && u.message.successful_payment) return onPayment(u.message);
    if (u.message && typeof u.message.text === 'string') return onMessage(u.message);
  }

  return { handleUpdate, COMMANDS };
}

module.exports = { createBotHandlers, COMMANDS };
