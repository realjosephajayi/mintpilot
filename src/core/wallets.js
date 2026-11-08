'use strict';
const { tx } = require('../db');
const { limitsFor } = require('./plans');
const { UserError } = require('../util/format');

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Format check, plus EIP-55 checksum enforcement for mixed-case input (loads ethers lazily). */
function normalizeAddress(input) {
  const s = String(input).trim();
  if (!ADDRESS_RE.test(s)) throw new UserError('That is not a valid EVM address (0x + 40 hex characters).');
  const hasUpper = /[A-F]/.test(s.slice(2));
  const hasLower = /[a-f]/.test(s.slice(2));
  if (hasUpper && hasLower) {
    try { require('ethers').getAddress(s); } catch { throw new UserError('Address checksum is wrong — check for a typo.'); }
  }
  if (/^0x0{40}$/.test(s)) throw new UserError('The zero address is not allowed.');
  return s.toLowerCase();
}

class WalletError extends UserError { constructor(code, message) { super(message); this.code = code; } }

function linkWallet(db, cfg, telegramId, address, sigType, now, encrypted = null) {
  return tx(db, () => {
    const addr = address.toLowerCase();
    const owner = db.prepare('SELECT telegram_id FROM wallets WHERE address=?').get(addr);
    if (owner && owner.telegram_id === String(telegramId)) {
      if (encrypted) {
        db.prepare('UPDATE wallets SET ciphertext=?, iv=?, auth_tag=?, salt=?, sig_type=?, verified_at=? WHERE address=? AND telegram_id=?')
          .run(encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.salt, sigType, now, addr, String(telegramId));
        const row = db.prepare('SELECT id FROM wallets WHERE address=?').get(addr);
        return { id: row.id, alreadyLinked: true, custodyUpdated: true };
      }
      return { id: null, alreadyLinked: true };
    }
    if (owner) throw new WalletError('WALLET_TAKEN', 'This wallet is already linked to another Telegram account.');
    const { wallets: max, plan } = limitsFor(cfg, db, telegramId, now);
    const have = db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE telegram_id=?').get(String(telegramId)).n;
    if (have >= max) throw new WalletError('WALLET_LIMIT', `Your ${plan} plan allows ${max} linked wallet${max === 1 ? '' : 's'}. Remove one with /wallets or upgrade with /premium.`);
    const r = encrypted
      ? db.prepare('INSERT INTO wallets (telegram_id, address, sig_type, verified_at, wallet_type, ciphertext, iv, auth_tag, salt) VALUES (?,?,?,?,?,?,?,?,?)').run(String(telegramId), addr, sigType, now, 'linked', encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.salt)
      : db.prepare('INSERT INTO wallets (telegram_id, address, sig_type, verified_at, wallet_type) VALUES (?,?,?,?,?)').run(String(telegramId), addr, sigType, now, 'linked');
    return { id: Number(r.lastInsertRowid), alreadyLinked: false, isFirst: have === 0 };
  });
}

const listWallets = (db, telegramId) => db.prepare('SELECT * FROM wallets WHERE telegram_id=? ORDER BY id').all(String(telegramId));

/** Unlink a wallet and cancel any not-yet-executed schedules that depend on it. */
function removeWallet(db, telegramId, walletId) {
  return tx(db, () => {
    const w = db.prepare('SELECT * FROM wallets WHERE id=? AND telegram_id=?').get(walletId, String(telegramId));
    if (!w || w.wallet_type === 'platform') return false;
    db.prepare("UPDATE schedules SET status='cancelled' WHERE telegram_id=? AND wallet_address=? AND status IN ('scheduled','ready')").run(String(telegramId), w.address);
    db.prepare('DELETE FROM wallets WHERE id=?').run(walletId);
    return true;
  });
}

module.exports = { normalizeAddress, linkWallet, listWallets, removeWallet, WalletError };
