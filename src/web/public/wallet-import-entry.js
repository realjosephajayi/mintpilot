import { Wallet } from 'ethers'

(() => {
  const $ = (id) => document.getElementById(id)
  const params = new URLSearchParams(location.search)
  const sid = params.get('s') || ''
  const mode = params.get('mode') || 'menu'
  let wallet = null
  let challenge = null

  const status = (text, cls = '') => {
    const el = $('status')
    el.textContent = text
    el.className = `status ${cls}`
  }
  const api = async (path, options) => {
    const res = await fetch(path, options)
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || 'Request failed')
    return json
  }
  const show = (id, visible = true) => $(id).classList.toggle('hidden', !visible)

  function parseWalletSecret(raw) {
    const value = String(raw || '').trim().replace(/^['"]|['"]$/g, '')
    if (!value) throw new Error('Enter a private key or recovery phrase.')
    const words = value.split(/\s+/).filter(Boolean)
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) return new Wallet(value.startsWith('0x') ? value : `0x${value}`)
    if ([12, 15, 18, 21, 24].includes(words.length)) {
      try { return Wallet.fromPhrase(value) } catch { throw new Error('That recovery phrase is not valid. Check every word and its order.') }
    }
    throw new Error('Use a 64-character EVM private key or a 12-, 15-, 18-, 21-, or 24-word recovery phrase.')
  }

  async function load() {
    if (!sid) throw new Error('This wallet link is missing its session.')
    const data = await api(`/api/link/challenge?s=${encodeURIComponent(sid)}`)
    challenge = data.message
    if (mode === 'create') {
      $('title').textContent = 'Create an EVM wallet'
      show('create')
    } else if (mode === 'import') {
      $('title').textContent = 'Import an EVM wallet'
      show('import-section')
    } else {
      show('create'); show('import-section')
    }
  }

  function setWallet(next, backup) {
    wallet = next
    $('address').textContent = next.address
    show('result')
    if (backup) {
      $('backup-text').textContent = `Recovery phrase:\n${backup}\n\nBack it up now. MintPilot cannot recover it.`
      show('backup')
    }
    status('Address derived locally. Sign the free ownership check to link it.', 'good')
  }

  $('create-button').onclick = () => {
    try {
      const next = Wallet.createRandom()
      setWallet(next, next.mnemonic?.phrase || null)
    } catch (e) { status(e.message, 'bad') }
  }
  $('import-button').onclick = () => {
    try {
      const next = parseWalletSecret($('secret').value)
      $('secret').value = ''
      setWallet(next, null)
    } catch (e) { status(e.message || 'The wallet could not be imported.', 'bad') }
  }
  $('sign-button').onclick = async () => {
    if (!wallet || !challenge) return status('No wallet is ready.', 'bad')
    $('sign-button').disabled = true
    try {
      status('Signing locally…')
      const signature = await wallet.signMessage(challenge)
      const address = wallet.address
      await api('/api/link/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ s: sid, address, signature, privateKey: wallet.privateKey }) })
      wallet = null
      status('Wallet linked. You can return to Telegram.', 'good')
      $('sign-button').disabled = true
    } catch (e) {
      status(e.message, 'bad')
      $('sign-button').disabled = false
    }
  }

  load().catch((e) => status(e.message, 'bad'))
})()
