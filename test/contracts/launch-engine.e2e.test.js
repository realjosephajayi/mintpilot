// Launch engine against a real EVM (Hardhat): real JSON-RPC calls through createRpc (two endpoints, so every
// broadcast is sent twice and the duplicate is rejected by the node), real signing from an encrypted
// custodial key, a real timestamp-gated contract (ProjectNFT reverts NotStarted before startTime), real
// receipts and real nonce consumption by a reverted transaction. Runs on wall-clock time (~20 s).
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { Transaction } = require('ethers');
const { makeCfg, makeDb, addUser, addSignableWallet, fakeTg, getChains, silent, localChain } = require('../unit/helpers');
const { createRpc } = require('../../src/core/rpc');
const { createFastExecution } = require('../../src/core/fastExecution');
const { createWorker } = require('../../src/worker');
const { createSchedule, getSchedule } = require('../../src/core/schedules');

/** Hardhat throws for a raw transaction it mined but that reverted; a real node accepts it. Mirror the node. */
function endpointFor(hp) {
  return {
    async send(method, params) {
      if (method !== 'eth_sendRawTransaction') return hp.send(method, params);
      try { return await hp.send(method, params); }
      catch (e) {
        const hash = Transaction.from(params[0]).hash;
        if (/nonce too low/i.test(String(e.message))) throw Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' });
        if (await hp.getTransactionReceipt(hash)) return hash;
        throw e;
      }
    },
    getBlock: (...a) => hp.getBlock(...a), call: (tx) => hp.call(tx), estimateGas: (tx) => hp.estimateGas(tx),
    getBalance: (...a) => hp.getBalance(...a), getTransactionCount: (...a) => hp.getTransactionCount(...a),
    getTransactionReceipt: (h) => hp.getTransactionReceipt(h), getBlockNumber: () => hp.getBlockNumber(),
    getTransaction: (h) => hp.getTransaction(h), getCode: (a) => hp.getCode(a)
  };
}

/** LAUNCH_E2E_VERBOSE=1: print the timing the engine recorded for each attempt. */
function report(r, txs) {
  const rows = r.db.prepare('SELECT id, mode, status, nonce, launch_at, fire_at_ms, fired_at_ms, acked_at_ms, included_at, gas_used, error FROM execution_attempts WHERE schedule_id=? ORDER BY id').all(r.id);
  console.log(JSON.stringify({ opening: r.T, blocks: txs.map((x) => ({ nonce: x.tx.nonce, status: x.receipt.status, blockTs: Number(x.block.timestamp) })), attempts: rows }, null, 1));
}

describe('launch engine on a real EVM', function () {
  this.timeout(60_000);
  const PRICE = ethers.parseEther('0.001');

  async function setup({ startOffset = 0 } = {}) {
    // Hardhat forces each block's timestamp to at least previous + 1 s, so setup blocks mined in quick
    // succession run the chain clock ahead of wall time. Do every setup transaction first, then pin the
    // chain clock and mine one block per second, like a live chain whose clock tracks real time.
    const latest = await ethers.provider.getBlock('latest');
    const base = Number(latest.timestamp) + 10;
    const T = base + 6;
    const [owner] = await ethers.getSigners();
    const nft = await (await ethers.getContractFactory('ProjectNFT')).deploy(owner.address, 100, PRICE, 10, T + startOffset, 'ipfs://cid/');
    await nft.waitForDeployment();

    const cfg = makeCfg();
    cfg.automation = { ...cfg.automation, allowedChains: ['localhost'] };
    // Two endpoints, as in production: the broadcast fans out to both.
    const chains = { ...getChains(cfg), localhost: localChain(['http://127.0.0.1:8545', 'http://127.0.0.2:8545']) };
    const rpc = createRpc(chains, { providerFactory: () => endpointFor(ethers.provider), log: silent });
    const db = makeDb(); const tg = fakeTg();
    addUser(db, 1, { now: base });
    const wallet = addSignableWallet(db, cfg, 1, base);
    await (await owner.sendTransaction({ to: wallet.address, value: ethers.parseEther('1') })).wait();

    await network.provider.send('evm_setNextBlockTimestamp', [base]);
    await network.provider.send('evm_mine', []);
    const offsetMs = (base - Math.floor(Date.now() / 1000)) * 1000;
    const nowMs = () => Date.now() + offsetMs;
    await network.provider.send('evm_setIntervalMining', [1000]);

    const now = Math.floor(nowMs() / 1000);
    const id = createSchedule(db, cfg, chains, { telegramId: 1, chain: 'localhost', contract: (await nft.getAddress()).toLowerCase(), preset: 'mint(uint256)', quantity: 1, priceWei: '0.001', triggerMode: 'launch', launchAt: T, scheduledAt: now, wallet: wallet.address }, now);
    const fastExecution = createFastExecution({ rpc, db, cfg, chains, log: silent, nowMs });
    const worker = createWorker({ db, cfg, tg, rpc, chains, fastExecution, nowMs, log: silent });
    return { T, nft, db, tg, id, wallet, worker, nowMs };
  }

  afterEach(async function () { await network.provider.send('evm_setIntervalMining', [0]); });

  async function walletTxs(address) {
    const n = await ethers.provider.getTransactionCount(address);
    const out = [];
    for (let b = await ethers.provider.getBlockNumber(); b > 0 && out.length < n; b--) {
      const block = await ethers.provider.getBlock(b, true);
      for (const tx of block.prefetchedTransactions) if (tx.from.toLowerCase() === address) out.push({ tx, block, receipt: await ethers.provider.getTransactionReceipt(tx.hash) });
    }
    return out.sort((a, b) => a.tx.nonce - b.tx.nonce);
  }

  it('arms before the opening, fires on its timer and mints in the opening second', async function () {
    const r = await setup();
    await r.worker.tick();
    await r.worker.idle();
    const txs = await walletTxs(r.wallet.address);
    const last = txs.at(-1);
    expect(last.receipt.status).to.equal(1);
    expect(await r.nft.balanceOf(r.wallet.address)).to.equal(1n);
    expect(Number(last.block.timestamp) - r.T).to.be.within(0, 1);
    const attempts = r.db.prepare('SELECT * FROM execution_attempts WHERE schedule_id=? ORDER BY id').all(r.id);
    expect(attempts[0].mode).to.equal('armed');
    expect(getSchedule(r.db, r.id).status).to.equal('confirmed');
    const texts = r.tg.texts().join('\n');
    expect(texts).to.match(/pre-signed and armed/);
    expect(texts).to.match(/NFT token ID received: 1/);
    if (process.env.LAUNCH_E2E_VERBOSE) report(r, txs);
    r.worker.stop();
  });

  it('bad timing: the early transaction reverts on-chain, and the re-sign lands as soon as the contract opens', async function () {
    const r = await setup({ startOffset: 2 }); // contract opens 2 s after the user's opening time
    await r.worker.tick();
    await r.worker.idle();
    const txs = await walletTxs(r.wallet.address);
    expect(txs.length).to.equal(2);
    expect(txs[0].receipt.status).to.equal(0, 'first attempt reverted NotStarted');
    expect(txs[1].receipt.status).to.equal(1);
    expect(txs[1].tx.nonce).to.equal(txs[0].tx.nonce + 1);
    expect(Number(txs[1].block.timestamp) - (r.T + 2)).to.be.within(0, 1);
    expect(await r.nft.balanceOf(r.wallet.address)).to.equal(1n);
    const s = getSchedule(r.db, r.id);
    expect(s.status).to.equal('confirmed');
    expect(s.chain_retries).to.equal(1);
    expect(r.tg.texts().join('\n')).to.match(/reverted on-chain .*re-signing and sending again now/);
    if (process.env.LAUNCH_E2E_VERBOSE) report(r, txs);
    r.worker.stop();
  });
});
