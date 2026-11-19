// The wallet Pay button: build a payment from a (pretend) wallet's coins, sign it like a wallet would, check the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createWalletPay } from '../chains/cardano-wallet.mjs';

const params = JSON.parse(readFileSync(new URL('./fixtures/epoch_params.json', import.meta.url)));
const wp = createWalletPay({ network: 'testnet', fetchJson: async () => [params], post: async () => ({ ok: true, text: async () => '' }), log: () => {} });
const C = wp._lib();
const skip = !C;

// a throwaway buyer wallet
const root = C && C.Bip32PrivateKey.from_bip39_entropy(randomBytes(32), Buffer.alloc(0));
const h = (n) => (n | 0x80000000) >>> 0;
const acct = root && root.derive(h(1852)).derive(h(1815)).derive(h(0));
const payKey = acct && acct.derive(0).derive(0);
const stakeKey = acct && acct.derive(2).derive(0);
const buyer = C && C.BaseAddress.new(0, C.Credential.from_keyhash(payKey.to_public().to_raw_key().hash()), C.Credential.from_keyhash(stakeKey.to_public().to_raw_key().hash())).to_address();
const shop = 'addr_test1qpx2ckxseyc8lqrxh0ej3ethukvmfe59pgeftmmal6rekg3v3ranmvaem6w8usmc33xl28m9hnqdyfas9jztpcyhrc3qrnnwhr';
const TOKEN = '31dde3db98ad05feb688d4dbb146b3b6054e1246cbcef98c79b0bf665553444378';
function utxo(lovelace, token = 0) {
  const v = C.Value.new(C.BigNum.from_str(String(lovelace)));
  if (token) {
    const ma = C.MultiAsset.new(), a = C.Assets.new();
    a.insert(C.AssetName.new(Buffer.from(TOKEN.slice(56), 'hex')), C.BigNum.from_str(String(token)));
    ma.insert(C.ScriptHash.from_hex(TOKEN.slice(0, 56)), a); v.set_multiasset(ma);
  }
  return C.TransactionUnspentOutput.new(C.TransactionInput.new(C.TransactionHash.from_bytes(randomBytes(32)), 0), C.TransactionOutput.new(buyer, v)).to_hex();
}
function walletSign(txHex) {   // what a CIP-30 wallet's signTx returns: a witness set
  const ft = C.FixedTransaction.from_hex(txHex);
  const ws = C.TransactionWitnessSet.new(), vk = C.Vkeywitnesses.new();
  vk.add(C.make_vkey_witness(ft.transaction_hash(), payKey.to_raw_key()));
  ws.set_vkeys(vk);
  return ws.to_hex();
}
const outputsOf = (hex) => { const b = C.FixedTransaction.from_hex(hex).body(); const o = b.outputs(); return Array.from({ length: o.len() }, (_, i) => o.get(i)); };

test('ADA payment: exact amount to the order address, change back, signature kept', { skip }, async () => {
  const r = await wp.build({ order: 'ord_a', address: shop, unit: 'lovelace', amount: '32830000', utxos: [utxo(20_000_000), utxo(50_000_000)], change: buyer.to_hex(), tip: { slot: 1000 } });
  const outs = outputsOf(r.tx);
  const toShop = outs.find((o) => o.address().to_bech32('addr_test') === shop);
  assert.equal(toShop.amount().coin().to_str(), '32830000');
  assert.ok(outs.some((o) => o.address().to_hex() === buyer.to_hex()), 'change goes back to the buyer');
  assert.ok(Number(r.fee) > 150000 && Number(r.fee) < 400000, 'normal fee: ' + r.fee);
  const done = wp.finish({ order: 'ord_a', tx: r.tx, witness: walletSign(r.tx) });
  assert.equal(done.hash, r.hash);
  const signed = C.FixedTransaction.from_hex(done.signed);
  assert.equal(signed.transaction_hash().to_hex(), r.hash);
  assert.equal(signed.witness_set().vkeys().len(), 1);
  assert.equal(await wp.submit(done.signed), true);
});

test('token payment (USDCx): exact tokens plus the little ADA Cardano needs', { skip }, async () => {
  const r = await wp.build({ order: 'ord_b', address: shop, unit: TOKEN, amount: '5000000', utxos: [utxo(5_000_000, 12_000_000)], change: buyer.to_hex(), tip: { slot: 1000 } });
  const toShop = outputsOf(r.tx).find((o) => o.address().to_bech32('addr_test') === shop);
  const ma = toShop.amount().multiasset();
  assert.equal(ma.get_asset(C.ScriptHash.from_hex(TOKEN.slice(0, 56)), C.AssetName.new(Buffer.from(TOKEN.slice(56), 'hex'))).to_str(), '5000000');
  assert.ok(Number(r.extra_ada) >= 900000 && Number(r.extra_ada) <= 1600000, 'min ADA ' + r.extra_ada);
});

test('refuses: not enough money, wrong network, unknown transaction, missing signature', { skip }, async () => {
  await assert.rejects(wp.build({ order: 'o', address: shop, unit: 'lovelace', amount: '90000000', utxos: [utxo(10_000_000)], change: buyer.to_hex(), tip: { slot: 1 } }), /enough/);
  const mainBuyer = C.BaseAddress.new(1, C.Credential.from_keyhash(payKey.to_public().to_raw_key().hash()), C.Credential.from_keyhash(stakeKey.to_public().to_raw_key().hash())).to_address();
  await assert.rejects(wp.build({ order: 'o', address: shop, unit: 'lovelace', amount: '1000000', utxos: [utxo(10_000_000)], change: mainBuyer.to_hex(), tip: { slot: 1 } }), /main network/);
  const r = await wp.build({ order: 'ord_c', address: shop, unit: 'lovelace', amount: '2000000', utxos: [utxo(10_000_000)], change: buyer.to_hex(), tip: { slot: 1 } });
  assert.throws(() => wp.finish({ order: 'ord_other', tx: r.tx, witness: walletSign(r.tx) }), /run out of time/);
  assert.throws(() => wp.finish({ order: 'ord_c', tx: r.tx, witness: C.TransactionWitnessSet.new().to_hex() }), /signature/);
});
