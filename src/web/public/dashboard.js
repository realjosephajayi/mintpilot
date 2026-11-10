'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const sid = new URLSearchParams(location.search).get('s') || '';
  const REFRESH_MS = 10000;
  const LIVE = new Set(['scheduled', 'ready', 'submitted']);
  const FILTERS = [
    ['all', 'All'], ['confirmed', 'Confirmed'], ['failed', 'Failed'], ['ended', 'Expired / cancelled']
  ];
  const state = { data: null, filter: 'all', skew: 0, timer: null, stopped: false };

  const status = (text, cls = '') => { $('status').textContent = text; $('status').className = `status ${cls}`; };
  const nowSec = () => Math.floor(Date.now() / 1000) + state.skew;
  const short = (value) => value && value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : (value || '—');
  const MONO = new Set(['Wallet', 'Transaction', 'NFT contract']);
  const tone = (text) => {
    if (/^Confirmed/.test(text)) return 'ok';
    if (/^(Failed|Not found|Stopped)/.test(text)) return 'bad';
    if (/^(Scheduled|Waiting|Running|Sent|Submitted|Sending|Test run|Prepared|Checking)/.test(text)) return 'info';
    return 'neutral';
  };

  // A table cell. `value` may be plain text, [text, tooltip, note], or { node } for custom content.
  const cell = (value, heading) => {
    const td = document.createElement('td');
    td.dataset.label = heading;
    if (MONO.has(heading)) td.className = 'mono';
    if (value && typeof value === 'object' && !Array.isArray(value) && value.node) { td.appendChild(value.node); return td; }
    const [raw, title = '', note = ''] = Array.isArray(value) ? value : [value];
    const text = raw == null || raw === '' ? '—' : String(raw);
    if (/^(Status|Outcome|Event)$/.test(heading) && text !== '—') {
      const box = document.createElement('div');
      box.className = 'stack';
      const chip = document.createElement('span');
      chip.className = `chip chip-${tone(text)}`;
      chip.textContent = text;
      box.appendChild(chip);
      if (note) { const n = document.createElement('small'); n.className = 'note'; n.textContent = note; box.appendChild(n); }
      td.appendChild(box);
    } else td.textContent = text;
    if (title) td.title = title;
    return td;
  };
  const local = (seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '—';
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value * 1000));
  };
  const utc = (seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '';
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(value * 1000));
  };
  const when = (seconds) => [local(seconds), utc(seconds)];
  const eth = (wei) => {
    try {
      const amount = BigInt(wei);
      const scale = 10n ** 18n;
      const whole = amount / scale;
      const fraction = (amount % scale).toString().padStart(18, '0').replace(/0+$/, '');
      return amount === 0n ? 'Free' : `${whole}${fraction ? `.${fraction}` : ''} ETH`;
    } catch { return '—'; }
  };
  const networkName = (key) => ({
    ethereum: 'Ethereum', mainnet: 'Ethereum', base: 'Base', ink: 'Ink', robinhood: 'Robinhood Chain',
    'robinhood-chain': 'Robinhood Chain', arbitrum: 'Arbitrum One', optimism: 'OP Mainnet', zora: 'Zora',
    shape: 'Shape', unichain: 'Unichain', soneium: 'Soneium'
  }[key] || String(key || '—').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
  const titleCase = (value) => String(value || 'Unknown').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const txStatus = (value) => ({ pending: 'Waiting for confirmation', submitted: 'Submitted', confirmed: 'Confirmed', failed: 'Failed', dropped: 'Not found on network' }[value] || titleCase(value));
  const eventLabel = (value) => ({
    armed: 'Prepared', submitting: 'Sending', uncertain: 'Checking result', submitted: 'Sent', reconciled: 'Confirmed on-chain', failed: 'Failed'
  }[value] || titleCase(value));

  // "in 12m 03s", "in 2h 5m", "4m ago"
  function relative(ts) {
    const diff = Number(ts) - nowSec();
    const abs = Math.abs(diff);
    const h = Math.floor(abs / 3600); const m = Math.floor((abs % 3600) / 60); const s = abs % 60;
    const text = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
    return diff > 0 ? `in ${text}` : (abs < 2 ? 'now' : `${text} ago`);
  }

  function explorerLink(chain, hash) {
    const base = state.data && state.data.explorers && state.data.explorers[chain];
    const span = document.createElement('span');
    if (!hash) { span.textContent = '—'; return { node: span }; }
    if (!base || !/^https?:\/\//.test(base)) { span.textContent = short(hash); span.title = hash; return { node: span }; }
    const a = document.createElement('a');
    a.href = `${base}/tx/${encodeURIComponent(hash)}`;
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = `${short(hash)} ↗`; a.title = hash;
    return { node: a };
  }
  const tokenText = (json) => {
    try {
      const ids = JSON.parse(json || '[]');
      return Array.isArray(ids) && ids.length ? ids.slice(0, 12).map((id) => `#${String(id).slice(0, 20)}`).join(', ') + (ids.length > 12 ? ` +${ids.length - 12} more` : '') : '';
    } catch { return ''; }
  };

  function table(target, headers, rows, emptyMessage) {
    const el = $(target);
    el.textContent = '';
    if (!rows.length) { el.textContent = emptyMessage; el.classList.add('empty-state'); return; }
    el.classList.remove('empty-state');
    const tableEl = document.createElement('table');
    const head = document.createElement('thead');
    const headingRow = document.createElement('tr');
    headers.forEach((heading) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = heading; headingRow.appendChild(th); });
    head.appendChild(headingRow); tableEl.appendChild(head);
    const body = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      row.forEach((item, i) => tr.appendChild(cell(item, headers[i])));
      body.appendChild(tr);
    });
    tableEl.appendChild(body); el.appendChild(tableEl);
  }

  // Live rows keep a ticking countdown: spans carry their target time and are refreshed every second.
  const countdownText = (el) => {
    const ts = Number(el.dataset.ts);
    const future = ts > nowSec();
    const rel = relative(ts);
    if (el.dataset.mode === 'launch') return future ? `Opens ${rel}` : `Opened ${rel}`;
    return future ? rel : `Due ${rel}`;
  };
  function countdown(schedule) {
    const box = document.createElement('div');
    box.className = 'stack';
    const date = document.createElement('span');
    const small = document.createElement('small'); small.className = 'note';
    if (schedule.trigger_mode === 'launch' && !schedule.launch_at) {
      date.textContent = 'When the mint opens';
      small.textContent = 'Waiting for it to open';
    } else {
      const target = schedule.trigger_mode === 'launch' ? schedule.launch_at : schedule.scheduled_at;
      date.textContent = local(target);
      date.title = utc(target);
      const span = document.createElement('span');
      span.dataset.ts = String(target);
      span.dataset.mode = schedule.trigger_mode === 'launch' ? 'launch' : 'manual';
      span.textContent = countdownText(span);
      small.appendChild(span);
    }
    box.appendChild(date); box.appendChild(small);
    return { node: box };
  }
  const liveLabel = (s) => {
    if (s.status === 'ready') return 'Test run passed';
    if (s.status === 'submitted') return 'Sent, confirming';
    const target = s.trigger_mode === 'launch' ? (s.launch_at || s.scheduled_at) : s.scheduled_at;
    return Number(target) > nowSec() ? 'Scheduled' : 'Running, waiting for the mint to open';
  };
  const outcomeLabel = (s) => ({ confirmed: 'Confirmed', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired' }[s.status] || titleCase(s.status));

  function render() {
    const data = state.data;
    if (!data) return;
    const wallets = Array.isArray(data.wallets) ? data.wallets : [];
    const schedules = Array.isArray(data.schedules) ? data.schedules : [];
    const tracked = Array.isArray(data.tracked) ? data.tracked : [];
    const activity = Array.isArray(data.activity) ? data.activity : [];
    const live = schedules.filter((s) => LIVE.has(s.status)).sort((a, b) => Number(a.scheduled_at) - Number(b.scheduled_at));
    const past = schedules.filter((s) => !LIVE.has(s.status));
    const inFilter = (s) => state.filter === 'all' || (state.filter === 'ended' ? (s.status === 'expired' || s.status === 'cancelled') : s.status === state.filter);
    const tokensBySchedule = new Map();
    tracked.forEach((t) => { if (t.schedule_id && t.token_ids) tokensBySchedule.set(t.schedule_id, tokenText(t.token_ids)); });

    $('live-count').textContent = live.length;
    $('done-count').textContent = past.filter((s) => s.status === 'confirmed').length;
    $('issue-count').textContent = past.filter((s) => s.status === 'failed' || s.status === 'expired').length;

    table('live', ['ID', 'Network', 'NFT contract', 'Starts', 'Wallet', 'Amount', 'Status'], live.map((s) => [
      `#${s.id}`, networkName(s.chain), [short(s.contract), s.contract], countdown(s),
      [short(s.wallet_address), s.wallet_address], eth(s.total_wei), [liveLabel(s), '', s.last_error || '']
    ]), 'No live or upcoming mints. Schedule one in the Telegram bot and it will show up here.');

    const filters = $('history-filters');
    if (!filters.childElementCount) {
      FILTERS.forEach(([key, label]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'filter'; b.dataset.filter = key; b.textContent = label;
        b.addEventListener('click', () => { state.filter = key; render(); });
        filters.appendChild(b);
      });
    }
    filters.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)));
    table('history', ['ID', 'Network', 'NFT contract', 'When', 'Wallet', 'Amount', 'Outcome', 'Transaction', 'NFTs received'], past.filter(inFilter).map((s) => [
      `#${s.id}`, networkName(s.chain), [short(s.contract), s.contract], when(s.scheduled_at),
      [short(s.wallet_address), s.wallet_address], eth(s.total_wei), [outcomeLabel(s), '', s.last_error || ''],
      explorerLink(s.chain, s.tx_hash), tokensBySchedule.get(s.id) || '—'
    ]), past.length ? 'Nothing matches this filter.' : 'No finished mints yet. Completed, failed and cancelled mints will be listed here.');

    table('activity', ['Time', 'Mint', 'Network', 'Event', 'Transaction'], activity.map((a) => [
      when(a.created_at), `#${a.schedule_id}`, networkName(a.chain), [eventLabel(a.status), '', a.error || ''], explorerLink(a.chain, a.tx_hash)
    ]), 'No attempts yet. MintPilot logs each try here once a mint starts.');

    table('tracked', ['Mint', 'Network', 'Status', 'Transaction', 'NFTs received'], tracked.map((t) => [
      t.schedule_id ? `#${t.schedule_id}` : 'Manual', networkName(t.chain), txStatus(t.status), explorerLink(t.chain, t.tx_hash), tokenText(t.token_ids) || '—'
    ]), 'Nothing here yet. Submitted mints will appear in this list.');

    table('wallets', ['Wallet', 'Added'], wallets.map((w) => [[short(w.address), w.address], when(w.verified_at)]), 'No wallets yet. Add one in the Telegram bot.');

    $('expiry').textContent = `Private link expires ${local(data.expiresAt)}.`;
  }

  function tickCountdowns() {
    document.querySelectorAll('[data-ts]').forEach((el) => { el.textContent = countdownText(el); });
  }

  async function load() {
    if (!sid) throw new Error('This dashboard link is incomplete. Return to Telegram and request a new /dashboard link.');
    const res = await fetch(`/api/dashboard?s=${encodeURIComponent(sid)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'We could not load your dashboard. Request a new link from Telegram.'); e.fatal = res.status === 400; throw e; }
    state.data = data;
    if (Number.isFinite(Number(data.now))) state.skew = Number(data.now) - Math.floor(Date.now() / 1000);
    render();
    status('', 'good');
    const t = new Date();
    $('live-updated').textContent = `Live: updated ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}, refreshes every ${REFRESH_MS / 1000}s.`;
  }

  function schedule() {
    clearTimeout(state.timer);
    if (state.stopped) return;
    state.timer = setTimeout(async () => {
      if (document.visibilityState === 'hidden') return schedule();
      try { await load(); }
      catch (error) {
        if (error.fatal) { state.stopped = true; status(error.message, 'bad'); return; }
        status('Connection lost, retrying…', 'bad');
      }
      schedule();
    }, REFRESH_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.stopped) load().then(() => status('', 'good')).catch(() => {});
  });
  setInterval(tickCountdowns, 1000);
  load().then(schedule).catch((error) => { state.stopped = Boolean(error.fatal); status(error.message, 'bad'); if (!state.stopped) schedule(); });
})();
