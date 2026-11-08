'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const sid = new URLSearchParams(location.search).get('s') || '';
  const status = (text, cls = '') => { $('status').textContent = text; $('status').className = `status ${cls}`; };
  const short = (value) => value && value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : (value || '—');
  const MONO = new Set(['Wallet address', 'Transaction', 'NFT contract']);
  const tone = (text) => {
    if (/^Confirmed/.test(text)) return 'ok';
    if (/^(Failed|Not found)/.test(text)) return 'bad';
    if (/^(Scheduled|Sent|Submitted|Waiting|Test run)/.test(text)) return 'info';
    return 'neutral';
  };
  const cell = (value, title = '', heading = '', note = '') => {
    const td = document.createElement('td');
    const text = value == null || value === '' ? '—' : String(value);
    td.dataset.label = heading;
    if (MONO.has(heading)) td.className = 'mono';
    if (heading === 'Status' && text !== '—') {
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
  const dateTime = (seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'UTC', timeZoneName: 'short'
    }).format(new Date(value * 1000));
  };
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
  const scheduleStatus = (value) => ({
    scheduled: 'Scheduled', ready: 'Test run passed', submitted: 'Sent',
    confirmed: 'Confirmed', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired'
  }[value] || String(value || 'Unknown').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
  const txStatus = (value) => ({
    pending: 'Waiting for confirmation', submitted: 'Submitted', confirmed: 'Confirmed',
    failed: 'Failed', dropped: 'Not found on network'
  }[value] || String(value || 'Unknown').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));

  function table(target, headers, rows, emptyMessage) {
    const el = $(target);
    el.textContent = '';
    if (!rows.length) { el.textContent = emptyMessage; el.classList.add('empty-state'); return; }
    el.classList.remove('empty-state');
    const tableEl = document.createElement('table');
    const head = document.createElement('thead');
    const headingRow = document.createElement('tr');
    headers.forEach((heading) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = heading;
      headingRow.appendChild(th);
    });
    head.appendChild(headingRow);
    tableEl.appendChild(head);
    const body = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      row.forEach((item, i) => tr.appendChild(Array.isArray(item) ? cell(item[0], item[1], headers[i], item[2]) : cell(item, '', headers[i])));
      body.appendChild(tr);
    });
    tableEl.appendChild(body);
    el.appendChild(tableEl);
  }

  async function load() {
    if (!sid) throw new Error('This dashboard link is incomplete. Return to Telegram and request a new /dashboard link.');
    const res = await fetch(`/api/dashboard?s=${encodeURIComponent(sid)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'We could not load your dashboard. Request a new link from Telegram.');

    const wallets = Array.isArray(data.wallets) ? data.wallets : [];
    const schedules = Array.isArray(data.schedules) ? data.schedules : [];
    const tracked = Array.isArray(data.tracked) ? data.tracked : [];
    $('wallet-count').textContent = wallets.length;
    $('schedule-count').textContent = schedules.length;
    $('transaction-count').textContent = tracked.length;

    table('wallets', ['Wallet address', 'Added'], wallets.map((wallet) => [
      [short(wallet.address), wallet.address],
      dateTime(wallet.verified_at)
    ]), 'No wallets yet. Add one in the Telegram bot.');

    table('schedules', ['ID', 'Network', 'NFT contract', 'When', 'Amount', 'Status'], schedules.map((schedule) => [
      `#${schedule.id}`,
      networkName(schedule.chain),
      [short(schedule.contract), schedule.contract],
      schedule.trigger_mode === 'launch' ? (schedule.launch_at ? `Mint opens ${dateTime(schedule.launch_at)}` : 'When the mint opens') : dateTime(schedule.scheduled_at),
      eth(schedule.total_wei),
      [scheduleStatus(schedule.status), '', schedule.last_error || '']
    ]), 'No mint schedules yet. Create one in the Telegram bot.');

    table('tracked', ['Mint', 'Network', 'Status', 'Transaction'], tracked.map((transaction) => [
      transaction.schedule_id ? `#${transaction.schedule_id}` : 'Manual',
      networkName(transaction.chain),
      txStatus(transaction.status),
      [short(transaction.tx_hash), transaction.tx_hash]
    ]), 'Nothing here yet. Submitted mints will appear in this list.');

    $('expiry').textContent = `Private link expires ${dateTime(data.expiresAt)}.`;
    status('', 'good');
  }

  load().catch((error) => status(error.message, 'bad'));
})();
