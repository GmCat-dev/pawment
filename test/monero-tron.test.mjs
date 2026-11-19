// Monero: subaddresses match monero-ts (official library); an output built the way a sending wallet builds it is
// found with the right amount (view tag + encrypted amount). The General Fund's published view key reaches its
// published donation address as subaddress 70. TRON: TRX and USDT payments through a pretend TronGrid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { moneroWallet, decodeAddress, hs } from '../chains/monero-keys.mjs';
import { keccak256 } from '../core/keccak.mjs';
import { L, B, add, mul, le, leBytes, decompress, compress } from '../core/ed25519.mjs';
import { createTronChain, checkTronAddress } from '../chains/tron.mjs';
import { createEngine } from '../core/engine.mjs';
import { validate } from '../core/settings.mjs';

const ref = JSON.parse(readFileSync(new URL('./fixtures/monero.json', import.meta.url)));
const varint = (n) => { const out = []; do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };

test('Monero subaddresses match monero-ts', () => {
  const w = moneroWallet(ref.address, ref.view_key);
  assert.equal(w.address(0), ref.address);
  for (const [i, a] of Object.entries(ref.subs)) assert.equal(w.address(Number(i)), a);
});

test('Monero: refuses a wrong view key, a subaddress as the main address, and typos', () => {
  const bad = ref.view_key.replace(/^./, ref.view_key[0] === '1' ? '2' : '1');
  assert.throws(() => moneroWallet(ref.address, bad), /does not belong/);
  assert.throws(() => moneroWallet(ref.subs[1], ref.view_key), /main \(primary\) address/);
  assert.throws(() => decodeAddress(ref.address.slice(0, -1) + (ref.address.endsWith('A') ? 'B' : 'A')), /typo|valid/);
});

test('the Monero General Fund: published view key reaches the published donation address (subaddress 70)', () => {
  const w = moneroWallet('44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A', 'f359631075708155cc3d92a32b75a7d02a5dcf27756707b47a2b31b21c389501');
  assert.equal(w.address(70), '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H');
});

/** build a one-output transaction to a subaddress the way a sending wallet does (tx key R = r*D) */
function fakeTx(subaddress, amount, { withTag = true } = {}) {
  const d = decodeAddress(subaddress);
  const r = le(randomBytes(32)) % L;
  const D = decompress(Buffer.from(d.spend)), C = decompress(Buffer.from(d.view));
  const R = compress(mul(r, D));
  const der = compress(mul(8n * r, C));
  const s = hs(Buffer.concat([der, varint(0)]));
  const P = compress(add(mul(le(s), B), D));
  const tag = keccak256(Buffer.concat([Buffer.from('view_tag'), der, varint(0)]))[0];
  const mask = keccak256(Buffer.concat([Buffer.from('amount'), s])).subarray(0, 8);
  const plain = Buffer.alloc(8); plain.writeBigUInt64LE(amount);
  const enc = Buffer.from(plain.map((b, k) => b ^ mask[k]));
  return { vout: [{ amount: 0, target: withTag ? { tagged_key: { key: P.toString('hex'), view_tag: tag.toString(16).padStart(2, '0') } } : { key: P.toString('hex') } }],
    extra: [1, ...R], rct_signatures: { type: 6, ecdhInfo: [{ amount: enc.toString('hex') }] } };
}

test('Monero: finds a payment to a subaddress and reads the hidden amount (with and without view tag)', () => {
  const w = moneroWallet(ref.address, ref.view_key);
  assert.equal(w.adopt(ref.subs[7]), true, 'recognises its own subaddress from the address alone (e.g. after a restart)');
  assert.equal(w.adopt('888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H'), false, 'and not someone else\'s');
  for (const withTag of [true, false]) {
    const f = w.scan(fakeTx(ref.subs[7], 123456789012n, { withTag }));
    assert.equal(f.length, 1);
    assert.equal(f[0].address, ref.subs[7]);
    assert.equal(f[0].amount, 123456789012n);
  }
  const other = moneroWallet('44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A', 'f359631075708155cc3d92a32b75a7d02a5dcf27756707b47a2b31b21c389501');
  other.address(0);
  assert.equal(other.scan(fakeTx(ref.subs[7], 5n)).length, 0, 'someone else\'s wallet sees nothing');
});

// ---------------------------------------------------------------- TRON
const SHOP = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';   // any valid T-address works for the test (this one is the USDT contract)
const USDT = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
test('TRON addresses: checksum and prefix', () => {
  assert.equal(checkTronAddress(SHOP), SHOP);
  assert.throws(() => checkTronAddress(SHOP.slice(0, -1) + (SHOP.endsWith('t') ? 'u' : 't')), /not a valid TRON/);
  assert.throws(() => checkTronAddress('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA'), /not a TRON address/);
});

test('TRON: TRX and USDT payments found, double-checked, and counted', async () => {
  const chain0 = createTronChain({ tokens: () => [] });
  const shopHex = chain0._toHex(SHOP), usdtHex = chain0._toHex(USDT);
  const st = { tip: 5000, trx: [], trc20: [], txs: {}, infos: {} };
  const fetchImpl = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : {};
    let j = {};
    if (u.pathname === '/wallet/getnowblock') j = { block_header: { raw_data: { number: st.tip } } };
    else if (u.pathname.endsWith('/transactions/trc20')) j = { data: st.trc20 };
    else if (u.pathname.endsWith('/transactions')) j = { data: st.trx };
    else if (u.pathname === '/wallet/gettransactionbyid') j = st.txs[body.value] || {};
    else if (u.pathname === '/wallet/gettransactioninfobyid') j = st.infos[body.value] || {};
    return { status: 200, text: async () => JSON.stringify(j) };
  };
  const chain = createTronChain({ tokens: () => [{ contract: USDT }], fetchImpl, log: () => {} });
  let clock = 1_800_000_000;
  const s = validate({ coins: [
    { id: 'TRX', chain: 'trx', unit: 'sun', decimals: 6, kind: 'native', price: { feeds: [] } },
    { id: 'USDTtrx', chain: 'trx', unit: 'trc20:' + USDT, decimals: 6, kind: 'stable', price: { fixed: 1 } }], sites: { shop: {} } });
  const engine = createEngine({ db: new DatabaseSync(':memory:'), settings: () => s, chains: { trx: chain }, prices: { get: (id) => ({ usd: id === 'TRX' ? 0.25 : 1, at: clock }) },
    siteSecret: () => null, alert: async () => {}, now: () => clock, log: () => {} });
  await engine.setWallet('trx', { address: SHOP });
  const o1 = engine.createOrder('shop', { amount: 10 }), q1 = engine.quote(o1.id, 'TRX').quote;
  const o2 = engine.createOrder('shop', { amount: 10 }), q2 = engine.quote(o2.id, 'USDTtrx').quote;
  const t1 = 'a1'.repeat(32), t2 = 'b2'.repeat(32);
  const trxTx = { txID: t1, ret: [{ contractRet: 'SUCCESS' }], blockNumber: 5001, raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { to_address: shopHex, amount: Number(q1.units) } } }] } };
  st.trx.push(trxTx); st.txs[t1] = trxTx; st.infos[t1] = { id: t1, blockNumber: 5001, receipt: {} };
  const data = 'a9059cbb' + shopHex.slice(2).padStart(64, '0') + BigInt(q2.units).toString(16).padStart(64, '0');
  st.txs[t2] = { txID: t2, ret: [{ contractRet: 'SUCCESS' }], raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: { contract_address: usdtHex, data } } }] } };
  st.infos[t2] = { id: t2, blockNumber: 5002, receipt: { result: 'SUCCESS' } };
  st.trc20.push({ transaction_id: t2, to: SHOP, type: 'Transfer', value: q2.units, token_info: { address: USDT } });
  st.tip = 5030;
  await engine.sweep();
  assert.equal(engine.publicView(o1.id).status, 'paid');
  assert.equal(engine.publicView(o2.id).status, 'paid');
  // a failed transaction pays nothing
  const o3 = engine.createOrder('shop', { amount: 10 }), q3 = engine.quote(o3.id, 'TRX').quote;
  const t3 = 'c3'.repeat(32);
  st.txs[t3] = { txID: t3, ret: [{ contractRet: 'OUT_OF_ENERGY' }], raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { to_address: shopHex, amount: Number(q3.units) } } }] } };
  assert.equal((await engine.claim(o3.id, t3)).found, false);
});
