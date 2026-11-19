import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createEngine } from '../core/engine.mjs';
import { validate, coinsFor } from '../core/settings.mjs';
import { createCardano } from '../chains/cardano.mjs';
import { hmac } from '../core/util.mjs';

const ref = JSON.parse(readFileSync(new URL('./fixtures/keys.json', import.meta.url)));
const GMGM = 'e4e55840913a7b5058e8591fc3d4d19574511e137b50e82f754a2ac3476d436174';
const USDCX = '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378';

function rig({ second = null, settings: extra = {} } = {}) {
  let clock = 1_800_000_000;
  const now = () => clock;
  const chainState = { tip: 1000, utxos: [], txs: {} };
  const real = createCardano({ network: 'mainnet', fetchJson: async () => { throw new Error('offline'); } });
  const fake = {
    ...real,
    second_source: second !== null,
    tip: async () => chainState.tip,
    incoming: async (addrs) => chainState.utxos.filter((u) => addrs.includes(u.address)),
    transaction: async (tx) => chainState.txs[tx] || null,
    confirm: async () => second,
  };
  let n = 0;
  const pay = (address, amounts, { height = chainState.tip } = {}) => {
    const tx = (++n).toString(16).padStart(64, 'a');
    const row = { ref: tx + '#0', tx, address, block_height: height, amounts: Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, BigInt(v)])) };
    chainState.utxos.push(row);
    chainState.txs[tx] = [row];
    return tx;
  };
  const s = validate({
    name: 'Test Pay', public_url: 'https://pay.test', featured: 'GMGM',
    coins: [
      { id: 'GMGM', chain: 'cardano', unit: GMGM, decimals: 0, name: '$GMGM', price: { pool: 'minswap' }, discount: 25 },
      { id: 'ADA', chain: 'cardano', unit: 'lovelace', decimals: 6, name: 'ADA', kind: 'native', price: { feeds: [] } },
      { id: 'USDCx', chain: 'cardano', unit: USDCX, decimals: 6, name: 'USDCx', kind: 'stable', price: { fixed: 1 } },
    ],
    sites: { shop: { name: 'Shop', notify_url: 'https://shop.test/paid' } },
    ...extra,
  });
  const sent = [];
  const priceMap = { ADA: 0.5, GMGM: 0.01, USDCx: 1 };
  const engine = createEngine({
    db: new DatabaseSync(':memory:'), settings: () => s, chains: { cardano: fake },
    prices: { get: (id) => (priceMap[id] ? { usd: priceMap[id], at: clock } : null) },
    siteSecret: () => ({ webhook_secret: 'whsec' }),
    post: async (url, init) => { sent.push({ url, ...init }); return { status: 200 }; },
    alert: async (subject) => sent.push({ alert: subject }), now, log: () => {},
  });
  return { engine, chainState, pay, sent, tick: (sec) => { clock += sec; }, s, priceMap, now };
}

async function setup(opts) {
  const r = rig(opts);
  await r.engine.setWallet('cardano', { account_key: ref.xpub });
  await r.engine.sweep();   // checks the first fresh addresses on the chain
  return r;
}

test('coin list: featured first, discounts, dates and minimums', () => {
  const s = validate({ featured: 'BB', coins: [
    { id: 'AA', chain: 'c', unit: 'x', decimals: 0, price: { fixed: 1 }, min_usd: 10 },
    { id: 'BB', chain: 'c', unit: 'y', decimals: 0, price: { fixed: 1 }, discount: 25 },
    { id: 'CC', chain: 'c', unit: 'z', decimals: 0, price: { fixed: 1 }, discount: 10, from: '2030-01-01' },
  ], sites: { s1: { featured: 'CC', coins: { BB: { discount: 0 } } } } });
  const at = Date.parse('2026-12-01') / 1000;
  assert.deepEqual(coinsFor(s, { usd: 5, at }).map((c) => [c.id, c.discount]), [['BB', 25], ['CC', 0]]);
  assert.deepEqual(coinsFor(s, { usd: 50, site: 's1', at }).map((c) => [c.id, c.discount]), [['CC', 0], ['AA', 0], ['BB', 0]]);
  assert.deepEqual(coinsFor(s, { usd: 5, discounts: false, at }).map((c) => c.discount), [0, 0]);
  assert.throws(() => validate({ featured: 'Z', coins: [] }), /featured/);
});

test('paid in ADA on a fresh address, confirmed, signed message sent', async () => {
  const { engine, pay, chainState, sent } = await setup();
  const order = engine.createOrder('shop', { amount: 10, item: 'Plus, 1 month', ref: 'u1' });
  let v = engine.quote(order.id, 'ADA');
  assert.equal(v.quote.amount, '20');
  assert.equal(v.quote.shared, false);
  assert.match(v.quote.address, /^addr1/);
  assert.match(v.quote.uri, /^web\+cardano:addr1.*\?amount=20$/);
  pay(v.quote.address, { lovelace: 20_000_000 });
  await engine.sweep();
  assert.equal(engine.publicView(order.id).status, 'seen');
  chainState.tip += 3;
  await engine.sweep();
  v = engine.publicView(order.id);
  assert.equal(v.status, 'paid');
  const msg = sent.find((x) => x.url === 'https://shop.test/paid');
  assert.ok(msg, 'paid message sent');
  const [t, sig] = msg.headers['pawment-signature'].split(',').map((p) => p.split('=')[1]);
  assert.equal(sig, hmac('whsec', t + '.' + msg.body));
  const body = JSON.parse(msg.body);
  assert.equal(body.event, 'order.paid');
  assert.equal(body.order.ref, 'u1');
  assert.equal(body.order.payment.coin, 'ADA');
});

test('each order gets its own address; $GMGM gets the discount', async () => {
  const { engine } = await setup();
  const a = engine.quote(engine.createOrder('shop', { amount: 10 }).id, 'GMGM');
  const b = engine.quote(engine.createOrder('shop', { amount: 10 }).id, 'GMGM');
  assert.equal(a.quote.usd, 7.5);
  assert.equal(a.quote.amount, '750');
  assert.notEqual(a.quote.address, b.quote.address);
  assert.equal(a.coins[0].id, 'GMGM');
  assert.equal(a.coins[0].badge, 'Save 25%');
});

test('underpaid stays open for the rest, then completes', async () => {
  const { engine, pay, chainState } = await setup();
  const o = engine.createOrder('shop', { amount: 10 });
  const v = engine.quote(o.id, 'ADA');
  pay(v.quote.address, { lovelace: 15_000_000 });
  chainState.tip += 5; await engine.sweep();
  let w = engine.publicView(o.id);
  assert.equal(w.status, 'part_paid');
  assert.equal(w.quote.left, '5');
  assert.throws(() => engine.quote(o.id, 'USDCx'), /finish in ADA/);
  pay(v.quote.address, { lovelace: 5_000_000 });
  chainState.tip += 5; await engine.sweep();
  w = engine.publicView(o.id);
  assert.equal(w.status, 'paid');
});

test('within tolerance counts as paid; overpaid lists the extra and can be refunded', async () => {
  const { engine, pay, chainState, sent } = await setup();
  const o1 = engine.createOrder('shop', { amount: 10 });
  const q1 = engine.quote(o1.id, 'ADA').quote;
  pay(q1.address, { lovelace: 19_800_000 });   // 1% short
  const o2 = engine.createOrder('shop', { amount: 10 });
  const q2 = engine.quote(o2.id, 'ADA').quote;
  pay(q2.address, { lovelace: 23_000_000 });   // 3 ADA extra
  chainState.tip += 5; await engine.sweep();
  assert.equal(engine.publicView(o1.id).status, 'paid');
  const v2 = engine.publicView(o2.id);
  assert.equal(v2.status, 'paid');
  assert.equal(v2.extra, '3');
  assert.ok(v2.can_refund);
  assert.throws(() => engine.requestRefund(o2.id, { address: 'addr1nope' }), /not a valid Cardano address/);
  const r = engine.requestRefund(o2.id, { address: ref.a5, note: 'sent too much' });
  await new Promise((res) => setTimeout(res, 10));
  assert.ok(sent.some((x) => /refund asked for/.test(x.alert || '')), 'owner gets an email about the refund request');
  assert.equal(r.refunds[0].amount, '3');
  assert.equal(r.refunds[0].kind, 'extra');
  assert.equal(r.can_refund, false);
  const rid = r.refunds[0].id;
  engine.adminAction('refund_approve', rid);
  // the owner sends it from their wallet; the server sees it arrive on the refund address
  pay(ref.a5, { lovelace: 3_000_000 });
  await engine.sweep();
  const after = engine.publicView(o2.id);
  assert.equal(after.refunds[0].status, 'sent');
  assert.equal(after.can_refund, false);
  assert.equal(after.extra, null);
  assert.ok(sent.some((x) => x.body && JSON.parse(x.body).event === 'order.refunded'));
});

test('refund window closes after refund_days', async () => {
  const { engine, pay, chainState, tick } = await setup();
  const o = engine.createOrder('shop', { amount: 10 });
  pay(engine.quote(o.id, 'ADA').quote.address, { lovelace: 20_000_000 });
  chainState.tip += 5; await engine.sweep();
  tick(8 * 86400);
  assert.equal(engine.publicView(o.id).can_refund, false);
  assert.throws(() => engine.requestRefund(o.id, { address: ref.a5 }), /7 days/);
});

test('token payment: the ADA riding along is not counted, $GMGM is', async () => {
  const { engine, pay, chainState } = await setup();
  const o = engine.createOrder('shop', { amount: 10 });
  const q = engine.quote(o.id, 'USDCx').quote;
  assert.equal(q.amount, '10');
  pay(q.address, { lovelace: 1_200_000, [USDCX]: 10_000_000 });
  chainState.tip += 5; await engine.sweep();
  const d = engine.adminOrder(o.id);
  assert.equal(d.order.status, 'paid');
  assert.deepEqual(d.payments.map((p) => p.state).sort(), ['carried', 'counted']);
});

test('late payment after the grace period goes to Payments to check', async () => {
  const { engine, pay, chainState, tick, sent } = await setup();
  const o = engine.createOrder('shop', { amount: 10 });
  const q = engine.quote(o.id, 'ADA').quote;
  tick(30 * 60 + 25 * 3600);
  pay(q.address, { lovelace: 20_000_000 });
  chainState.tip += 5; await engine.sweep();
  assert.equal(engine.publicView(o.id).status, 'check');
  assert.equal(engine.toCheck().payments.length, 1);
  await new Promise((res) => setTimeout(res, 10));
  assert.ok(sent.some((x) => /a payment needs you/.test(x.alert || '')), 'owner gets an email about the late payment');
  engine.adminAction('accept', o.id);
  assert.equal(engine.publicView(o.id).status, 'paid');
});

test('payment inside the grace period still counts at the held price', async () => {
  const { engine, pay, chainState, tick, priceMap } = await setup();
  const o = engine.createOrder('shop', { amount: 10 });
  const q = engine.quote(o.id, 'ADA').quote;
  priceMap.ADA = 1;   // price doubled meanwhile
  tick(3 * 3600);
  pay(q.address, { lovelace: 20_000_000 });
  chainState.tip += 5; await engine.sweep();
  assert.equal(engine.publicView(o.id).status, 'paid');
});

test('single-address wallet: unique amounts; a wrong amount goes to check, other money is ignored', async () => {
  const r = rig();
  await r.engine.setWallet('cardano', { address: ref.a0 });
  const a = r.engine.quote(r.engine.createOrder('shop', { amount: 10 }).id, 'ADA');
  const bOrder = r.engine.createOrder('shop', { amount: 10 });
  const b = r.engine.quote(bOrder.id, 'ADA');
  assert.equal(a.quote.address, b.quote.address);
  assert.notEqual(a.quote.amount, b.quote.amount);
  assert.ok(a.quote.shared);
  r.pay(a.quote.address, { lovelace: a.quote.units });
  r.pay(a.quote.address, { lovelace: 20_500_000 });      // close to an order but not exact
  r.pay(a.quote.address, { lovelace: 500_000_000 });     // the owner's own money
  r.chainState.tip += 5; await r.engine.sweep();
  assert.equal(r.engine.publicView(a.id).status, 'paid');
  assert.equal(r.engine.toCheck().payments.length, 1);
  assert.equal(r.engine.publicView(bOrder.id).status, 'check');
});

test('"I already paid" finds a payment by transaction id', async () => {
  const { engine, pay, chainState } = await setup();
  const o = engine.createOrder('shop', { amount: 10 });
  const q = engine.quote(o.id, 'ADA').quote;
  const tx = pay(q.address, { lovelace: 20_000_000 });
  chainState.utxos = [];
  await assert.rejects(engine.claim(o.id, 'nope'), /64 letters/);
  const res = await engine.claim(o.id, tx);
  assert.equal(res.found, true);
  chainState.tip += 5; await engine.sweep();
  assert.equal(engine.publicView(o.id).status, 'paid');
  const other = engine.createOrder('shop', { amount: 10 });
  engine.quote(other.id, 'ADA');
  await assert.rejects(engine.claim(other.id, tx), /different order/);
});

test('the two blockchain services disagree: payment held for checking', async () => {
  const { engine, pay, chainState } = await setup({ second: false });
  const o = engine.createOrder('shop', { amount: 10 });
  pay(engine.quote(o.id, 'ADA').quote.address, { lovelace: 20_000_000 });
  chainState.tip += 5; await engine.sweep();
  assert.equal(engine.publicView(o.id).status, 'check');
});

test('a fresh address that already has money (used in the wallet app) is skipped', async () => {
  const r = rig();
  await r.engine.setWallet('cardano', { account_key: ref.xpub });
  const { baseAddress, parseAccountKey } = await import('../chains/cardano-keys.mjs');
  const key = parseAccountKey(ref.xpub);
  r.pay(baseAddress(key, 1), { lovelace: 5_000_000 });   // the owner received money on index 1 in their wallet
  await r.engine.sweep();
  const q = r.engine.quote(r.engine.createOrder('shop', { amount: 10 }).id, 'ADA').quote;
  assert.equal(q.address, baseAddress(key, 2));
});

test('changing the wallet sends an urgent alert; waiting orders keep their address', async () => {
  const { engine, sent } = await setup();
  const o = engine.createOrder('shop', { amount: 10 });
  const before = engine.quote(o.id, 'ADA').quote.address;
  await engine.setWallet('cardano', { address: ref.a5 });
  assert.ok(sent.some((x) => /URGENT/.test(x.alert || '')));
  assert.equal(engine.publicView(o.id).quote.address, before);
  const next = engine.quote(engine.createOrder('shop', { amount: 10 }).id, 'ADA').quote.address;
  assert.equal(next, ref.a5);
});

test('gap budget: never more unused fresh addresses than allowed', async () => {
  const { engine } = await setup({ settings: { gap_budget: 5 } });
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const q = engine.quote(engine.createOrder('shop', { amount: 10 }).id, 'ADA').quote;
    if (!q.shared) seen.add(q.address);
    await engine.sweep();
  }
  assert.ok(seen.size <= 5, `handed out ${seen.size} fresh addresses`);
});

test('ledger lists payments and refunds', async () => {
  const { engine, pay, chainState } = await setup();
  const o = engine.createOrder('shop', { amount: 10, item: 'Plus' });
  pay(engine.quote(o.id, 'ADA').quote.address, { lovelace: 20_000_000 });
  chainState.tip += 5; await engine.sweep();
  const l = engine.ledger();
  assert.equal(l.length, 1);
  assert.equal(l[0].amount, '20');
  assert.equal(l[0].usd, 10);
});

test('a dollar coin that loses its peg is paused', async () => {
  const { createPrices } = await import('../core/prices.mjs');
  const s = validate({ coins: [{ id: 'DJED', chain: 'cardano', unit: 'x', decimals: 6, kind: 'stable', price: { feeds: ['coingecko:djed'] } }] });
  let v = 0.9;
  const pr = createPrices({ settings: () => s, chains: {}, fetchJson: async () => ({ djed: { usd: v } }), log: () => {}, now: () => 1 });
  await pr.refresh();
  assert.equal(pr.get('DJED'), null);
  v = 1.01;
  await pr.refresh();
  assert.equal(pr.get('DJED').usd, 1.01);
});

test('Bitcoin: fresh bc1 address, tidy amount, seen while waiting, counted once mined and double-checked', async () => {
  const { createUtxoChain } = await import('../chains/utxo.mjs');
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/btc-family.json', import.meta.url)));
  let clock = 1_800_000_000; const now = () => clock;
  const st = { tip: 900000, utxos: [] };
  const base = createUtxoChain('BTC', { pool: { close() {} } });
  const btc = { ...base, tip: async () => st.tip, incoming: async (a) => st.utxos.filter((u) => a.includes(u.address)), transaction: async () => null, confirm: async () => true };
  const s = validate({ public_url: 'https://pay.test', coins: [{ id: 'BTC', chain: 'btc', unit: 'sat', decimals: 8, kind: 'native', price: { feeds: [] } }], sites: { shop: {} } });
  const engine = createEngine({ db: new DatabaseSync(':memory:'), settings: () => s, chains: { btc }, prices: { get: () => ({ usd: 90000, at: clock }) },
    siteSecret: () => null, post: async () => ({ status: 200 }), alert: async () => {}, now, log: () => {} });
  await engine.setWallet('btc', { account_key: fixtures.find((f) => f.name === 'btc-zpub').xpub });
  await engine.sweep();
  const o = engine.createOrder('shop', { amount: 10 });
  const q = engine.quote(o.id, 'BTC').quote;
  assert.match(q.address, /^bc1q/);
  assert.equal(q.address, fixtures.find((f) => f.name === 'btc-zpub').addrs[1]);   // index 1 (0 is the wallet's own)
  assert.equal(Number(q.units) % 10, 0, 'tidy to 10 sats');
  assert.ok(Math.abs(Number(q.units) / 1e8 * 90000 - 10) < 0.02, 'about $10: ' + q.amount);
  assert.match(q.uri, /^bitcoin:bc1q.*\?amount=0\.000111/);
  st.utxos.push({ ref: 'ab'.repeat(32) + ':0', tx: 'ab'.repeat(32), address: q.address, block_height: null, amounts: { sat: BigInt(q.units) } });
  await engine.sweep();
  assert.equal(engine.publicView(o.id).status, 'seen');
  st.utxos[0].block_height = 900001; st.tip = 900001;
  await engine.sweep();
  assert.equal(engine.publicView(o.id).status, 'paid');
});

test('shared address offsets stay tiny for valuable coins', async () => {
  const { createUtxoChain } = await import('../chains/utxo.mjs');
  let clock = 1_800_000_000;
  const btc = { ...createUtxoChain('BTC', { pool: { close() {} } }), tip: async () => 1, incoming: async () => [] };
  const s = validate({ coins: [{ id: 'BTC', chain: 'btc', unit: 'sat', decimals: 8, kind: 'native', price: { feeds: [] } }], sites: { shop: {} } });
  const engine = createEngine({ db: new DatabaseSync(':memory:'), settings: () => s, chains: { btc }, prices: { get: () => ({ usd: 90000, at: clock }) },
    siteSecret: () => null, alert: async () => {}, now: () => clock, log: () => {} });
  await engine.setWallet('btc', { address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' });
  const amounts = [];
  for (let i = 0; i < 5; i++) amounts.push(Number(engine.quote(engine.createOrder('shop', { amount: 10 }).id, 'BTC').quote.units));
  assert.equal(new Set(amounts).size, 5);
  for (const a of amounts) assert.ok(a / 1e8 * 90000 - 10 < 0.1, 'extra under 10 cents: ' + a);
});

test('a $1 order in a dollar coin on a shared address asks for at most about a cent more', async () => {
  const r = rig();
  await r.engine.setWallet('cardano', { address: ref.a0 });
  for (let i = 0; i < 20; i++) {
    const q = r.engine.quote(r.engine.createOrder('shop', { amount: 1 }).id, 'USDCx').quote;
    assert.ok(Number(q.amount) > 1 && Number(q.amount) <= 1.0099, 'asked ' + q.amount);
  }
});

test('added tokens: live markets win over a lagging CoinGecko; live sources that disagree are refused', async () => {
  const { createPrices } = await import('../core/prices.mjs');
  const s = validate({ coins: [{ id: 'ADA', chain: 'cardano', unit: 'lovelace', decimals: 6, kind: 'native', price: { fixed: 0.5 } },
    { id: 'TOK', chain: 'cardano', unit: 'aa'.repeat(28) + '544f4b', decimals: 0, kind: 'token', price: { token: true } }] });
  let dex = 0.010, cg = 0.013, pool = 0.0102 / 0.5;   // pool price is in ADA
  const fetchJson = async (url) => {
    if (url.includes('dexscreener')) return { pairs: [{ chainId: 'cardano', baseToken: { address: 'aa'.repeat(28) + '544f4b' }, priceUsd: String(dex), liquidity: { usd: 5000 } }] };
    if (url.includes('coingecko')) return { market_data: { current_price: { usd: cg } } };
    throw new Error('unexpected');
  };
  const chains = { cardano: { poolPrice: async () => ({ price: pool, sources: {} }) } };
  const pr = createPrices({ settings: () => s, chains, fetchJson, log: () => {}, now: () => 1 });
  await pr.refresh();
  assert.ok(Math.abs(pr.get('TOK').usd - 0.0101) < 0.0002, 'uses the live markets');
  assert.match(pr.get('TOK').warning, /CoinGecko/);
  pool = 0.02 / 0.5; await pr.refresh();
  assert.ok(pr.get('TOK').usd < 0.0102, 'disagreeing live sources: old price kept, no new one');
});

test('retention: unpaid orders go after 90 days, paid ones stay (7 years)', async () => {
  const { engine, pay, chainState, tick } = await setup();
  const unpaid = engine.createOrder('shop', { amount: 10 });
  engine.quote(unpaid.id, 'ADA');
  const paid = engine.createOrder('shop', { amount: 10 });
  pay(engine.quote(paid.id, 'ADA').quote.address, { lovelace: 20_000_000 });
  chainState.tip += 5; await engine.sweep();
  tick(91 * 86400);
  await engine.sweep();
  assert.throws(() => engine.publicView(unpaid.id), /does not exist/);
  assert.equal(engine.publicView(paid.id).status, 'paid');
});

test('refund with the network fee taken out still counts as sent, and the ledger shows what was sent', async () => {
  const { engine, pay, chainState } = await setup();
  const o = engine.createOrder('shop', { amount: 10 });
  pay(engine.quote(o.id, 'ADA').quote.address, { lovelace: 20_000_000 });
  chainState.tip += 5; await engine.sweep();
  const r = engine.requestRefund(o.id, { address: ref.a5 });
  engine.adminAction('refund_approve', r.refunds[0].id);
  pay(ref.a5, { lovelace: 19_830_000 });   // 20 ADA minus a 0.17 ADA fee
  await engine.sweep();
  const v = engine.publicView(o.id);
  assert.equal(v.refunds[0].status, 'sent');
  assert.equal(v.refunds[0].amount, '19.83');
  assert.equal(engine.ledger().find((l) => l.type === 'refund').amount, '-19.83');
});

test('cardano: Blockfrost takes over when Koios is busy, then Koios is left alone for a while', async () => {
  const { createCardanoSource } = await import('../chains/cardano-source.mjs');
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.includes('koios')) throw new Error('api.koios.rest answered 429');
    if (url.endsWith('/blocks/latest')) return { height: 1234, slot: 99 };
    if (url.includes('/addresses/addr_a/utxos')) return url.includes('page=1') ? [{ tx_hash: 'f'.repeat(64), output_index: 1, block: 'bh', amount: [{ unit: 'lovelace', quantity: '5000000' }, { unit: 'ab'.repeat(28) + '01', quantity: '7' }] }] : [];
    if (url.includes('/addresses/addr_b/utxos')) throw new Error('cardano-mainnet.blockfrost.io answered 404');
    if (url.endsWith('/blocks/bh')) return { height: 1200 };
    throw new Error('unexpected ' + url);
  };
  let t = 1000;
  const src = createCardanoSource({ network: 'mainnet', fetchJson, blockfrostKey: 'k', log: () => {}, clock: () => t });
  const c = createCardano({ network: 'mainnet', fetchJson, source: src });
  assert.equal(await c.tip(), 1234);
  assert.equal(src.status().using, 'blockfrost');
  const rows = await c.incoming(['addr_a', 'addr_b']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, 'f'.repeat(64) + '#1');
  assert.equal(rows[0].block_height, 1200);
  assert.equal(rows[0].amounts.lovelace, 5000000n);
  assert.equal(rows[0].amounts['ab'.repeat(28) + '01'], 7n);
  const before = calls.filter((u) => u.includes('koios')).length;
  await c.tip();   // Koios is paused: not asked again
  assert.equal(calls.filter((u) => u.includes('koios')).length, before);
  t += 16 * 60;    // after the pause Koios is tried again
  await c.tip();
  assert.equal(calls.filter((u) => u.includes('koios')).length, before + 1);
});

test('cardano: without a Blockfrost key a busy Koios is still an error', async () => {
  const c = createCardano({ network: 'mainnet', fetchJson: async () => { throw new Error('api.koios.rest answered 429'); } });
  await assert.rejects(() => c.tip(), /429/);
});
