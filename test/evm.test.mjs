// Ethereum family against a pretend JSON-RPC chain: wallet-button payment (pending, then mined), USDC via Transfer
// events, a failed transaction, the second-server check, checksums and payment links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEvmChain, tokenUnit } from '../chains/evm.mjs';
import { createEngine } from '../core/engine.mjs';
import { validate } from '../core/settings.mjs';
import { usdToUnits } from '../core/util.mjs';

const SHOP = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const h = (n) => '0x' + BigInt(n).toString(16);
const pad = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

function fakeChain() {
  const st = { tip: 1000, balance: 0n, blocks: {}, txs: {}, receipts: {}, logs: [], disagree: false };
  const fetchImpl = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const second = !url.includes('publicnode');
    let result = null;
    if (method === 'eth_blockNumber') result = h(st.tip);
    else if (method === 'eth_getBalance') result = h(st.balance);
    else if (method === 'eth_getBlockByNumber') result = st.blocks[Number(params[0])] || { transactions: [] };
    else if (method === 'eth_getTransactionByHash') result = st.txs[params[0]] || null;
    else if (method === 'eth_getTransactionReceipt') { result = st.receipts[params[0]] || null; if (result && second && st.disagree) result = { ...result, status: '0x0' }; }
    else if (method === 'eth_getLogs') {
      const f = params[0];
      result = st.logs.filter((l) => Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock) && f.address.includes(l.address.toLowerCase()) && l.topics[2] === f.topics[2]);
    }
    return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
  };
  const chain = createEvmChain('eth', { tokens: () => [{ contract: USDC }], fetchImpl, log: () => {} });
  let n = 0;
  const hash = () => '0x' + (++n).toString(16).padStart(64, 'e');
  return {
    st, chain, fetchImpl,
    sendCoin(value, { mined = true } = {}) {
      const tx = { hash: hash(), to: SHOP.toLowerCase(), value: h(value), input: '0x', blockNumber: mined ? h(st.tip) : null };
      st.txs[tx.hash] = tx;
      if (mined) { st.receipts[tx.hash] = { status: '0x1', blockNumber: tx.blockNumber, logs: [] }; (st.blocks[st.tip] ||= { transactions: [] }).transactions.push(tx); st.balance += BigInt(value); }
      return tx;
    },
    mine(tx) {
      tx.blockNumber = h(st.tip);
      st.receipts[tx.hash] = { status: '0x1', blockNumber: tx.blockNumber, logs: [] };
      (st.blocks[st.tip] ||= { transactions: [] }).transactions.push(tx);
      st.balance += BigInt(tx.value);
    },
    sendUsdc(amount) {
      const txh = hash();
      const lg = { address: USDC.toLowerCase(), topics: [TRANSFER, pad('0x1111111111111111111111111111111111111111'), pad(SHOP)], data: h(amount), blockNumber: h(st.tip), transactionHash: txh };
      st.logs.push(lg);
      st.txs[txh] = { hash: txh, to: USDC.toLowerCase(), value: '0x0', input: '0xa9059cbb' + pad(SHOP).slice(2) + pad(h(amount)).slice(2), blockNumber: h(st.tip) };
      st.receipts[txh] = { status: '0x1', blockNumber: h(st.tip), logs: [lg] };
      return txh;
    },
  };
}

function rig() {
  const f = fakeChain();
  let clock = 1_800_000_000;
  const s = validate({ coins: [
    { id: 'ETH', chain: 'eth', unit: 'wei', decimals: 18, kind: 'native', price: { feeds: [] } },
    { id: 'USDC', chain: 'eth', unit: tokenUnit(USDC), decimals: 6, kind: 'stable', price: { fixed: 1 } },
  ], sites: { shop: {} } });
  const engine = createEngine({ db: new DatabaseSync(':memory:'), settings: () => s, chains: { eth: f.chain },
    prices: { get: (id) => ({ usd: id === 'ETH' ? 2000 : 1, at: clock }) }, siteSecret: () => null, alert: async () => {}, now: () => clock, log: () => {} });
  return { ...f, engine };
}

test('exact amounts for 18-decimal coins', () => {
  assert.equal(usdToUnits(10, 2000, 18).toString(), '5000000000000000');
  assert.equal(usdToUnits(10, 1, 18).toString(), '10000000000000000000');   // BNB Chain USDT has 18 decimals
  assert.equal(usdToUnits(10, 3, 18).toString(), '3333333333333333334');
});

test('wallet only takes a checksummed 0x address', async () => {
  const { engine } = rig();
  await assert.rejects(engine.setWallet('eth', { account_key: 'xpub123' }), /one ordinary 0x address/);
  await assert.rejects(engine.setWallet('eth', { address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAee' }), /typo/);
  const w = await engine.setWallet('eth', { address: SHOP.toLowerCase() });
  assert.equal(w.first_addresses[0], SHOP);
});

test('ETH via the wallet button: seen while pending, counted once mined and double-checked', async () => {
  const r = rig();
  await r.engine.setWallet('eth', { address: SHOP });
  await r.engine.sweep();   // first look: notes the balance
  const o = r.engine.createOrder('shop', { amount: 10 });
  const q = r.engine.quote(o.id, 'ETH').quote;
  assert.ok(q.shared);
  assert.equal(q.pay.chain_id, 1);
  assert.match(q.uri, /^ethereum:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed@1\?value=\d+$/);
  const tx = r.sendCoin(q.units, { mined: false });
  const claim = await r.engine.claim(o.id, tx.hash);
  assert.equal(claim.found, true);
  assert.equal(r.engine.publicView(o.id).status, 'seen');
  r.st.tip += 1; r.mine(tx); r.st.tip += 3;
  await r.engine.sweep();
  assert.equal(r.engine.publicView(o.id).status, 'paid');
});

test('USDC found through its Transfer event', async () => {
  const r = rig();
  await r.engine.setWallet('eth', { address: SHOP });
  await r.engine.sweep();
  const o = r.engine.createOrder('shop', { amount: 25 });
  const q = r.engine.quote(o.id, 'USDC').quote;
  assert.match(q.uri, /^ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48@1\/transfer\?address=0x5aAeb/i);
  assert.equal(q.pay.contract, USDC);
  r.st.tip += 1; r.sendUsdc(q.units); r.st.tip += 3;
  await r.engine.sweep();
  assert.equal(r.engine.publicView(o.id).status, 'paid');
});

test('a coin payment without the button is found when the balance moves', async () => {
  const r = rig();
  await r.engine.setWallet('eth', { address: SHOP });
  await r.engine.sweep();
  const o = r.engine.createOrder('shop', { amount: 10 });
  const q = r.engine.quote(o.id, 'ETH').quote;
  r.st.tip += 1; r.sendCoin(q.units); r.st.tip += 3;
  await r.engine.sweep();
  assert.equal(r.engine.publicView(o.id).status, 'paid');
});

test('failed transactions pay nothing; servers disagreeing goes to checking', async () => {
  const r = rig();
  await r.engine.setWallet('eth', { address: SHOP });
  await r.engine.sweep();
  const o = r.engine.createOrder('shop', { amount: 10 });
  const q = r.engine.quote(o.id, 'ETH').quote;
  const tx = r.sendCoin(q.units);
  r.st.receipts[tx.hash].status = '0x0';
  assert.equal((await r.engine.claim(o.id, tx.hash)).found, false);
  const o2 = r.engine.createOrder('shop', { amount: 10 });
  const q2 = r.engine.quote(o2.id, 'ETH').quote;
  r.st.disagree = true;
  r.st.tip += 1; r.sendCoin(q2.units); r.st.tip += 3;
  await r.engine.sweep();
  assert.equal(r.engine.publicView(o2.id).status, 'check');
});

test('a coin payment made while the server was restarting is still found', async () => {
  const f = fakeChain();
  const db = new DatabaseSync(':memory:');
  let clock = 1_800_000_000;
  const s = validate({ coins: [{ id: 'ETH', chain: 'eth', unit: 'wei', decimals: 18, kind: 'native', price: { feeds: [] } }], sites: { shop: {} } });
  const mk = (chain) => createEngine({ db, settings: () => s, chains: { eth: chain }, prices: { get: () => ({ usd: 2000, at: clock }) }, siteSecret: () => null, alert: async () => {}, now: () => clock, log: () => {} });
  const e1 = mk(f.chain);
  await e1.setWallet('eth', { address: SHOP });
  const o = e1.createOrder('shop', { amount: 10 });
  const q = e1.quote(o.id, 'ETH').quote;
  await e1.sweep();                      // reading position saved
  // "restart": a brand-new plug-in; meanwhile, 40 blocks pass and the payment lands in one of them
  f.st.tip += 20; f.sendCoin(q.units); f.st.tip += 20;
  const chain2 = createEvmChain('eth', { tokens: () => [{ contract: USDC }], fetchImpl: f.fetchImpl, log: () => {} });
  const e2 = mk(chain2);
  await e2.sweep();
  assert.equal(e2.publicView(o.id).status, 'paid');
});
