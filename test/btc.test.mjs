// Bitcoin family: our addresses must match well-known libraries (bitcoinjs-lib, scure-bip32, bchaddrjs) exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseExtended, ckdPub, cashDecode, segwitDecode } from '../chains/btc-keys.mjs';
import { profileFor, makeAddress, readAddress } from '../chains/utxo-coins.mjs';

const ref = JSON.parse(readFileSync(new URL('./fixtures/btc-family.json', import.meta.url)));
const coinOf = (name) => name.split('-')[0].toUpperCase();

for (const r of ref) {
  test(`addresses match the reference: ${r.name}`, () => {
    const p = profileFor(coinOf(r.name), 'mainnet');
    const k = parseExtended(r.xpub, p.versions, { check: p.check });
    const recv = ckdPub(k, 0);
    [0, 1, 7].forEach((i, n) => assert.equal(makeAddress(p, k.type, ckdPub(recv, i).key).address, r.addrs[n]));
  });
}

test('the BIP84 standard\'s own example address', () => {
  const p = profileFor('BTC', 'mainnet');
  const k = parseExtended('zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs', p.versions);
  assert.equal(makeAddress(p, k.type, ckdPub(ckdPub(k, 0), 0).key).address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
});

test('refuses private keys, other coins\' keys and typos', () => {
  const btc = profileFor('BTC', 'mainnet'), bch = profileFor('BCH', 'mainnet');
  assert.throws(() => parseExtended('xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu', btc.versions), /PRIVATE/);
  const z = ref.find((r) => r.name === 'btc-zpub').xpub;
  assert.throws(() => parseExtended(z, bch.versions), /not for this coin/);
  assert.throws(() => parseExtended(z.slice(0, -1) + (z.endsWith('s') ? 't' : 's'), btc.versions), /could not be read/);
});

test('reading addresses people type (refunds)', () => {
  const btc = profileFor('BTC', 'mainnet'), ltc = profileFor('LTC', 'mainnet'), bch = profileFor('BCH', 'mainnet');
  assert.equal(readAddress(btc, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu').script.toString('hex').slice(0, 4), '0014');
  assert.equal(readAddress(btc, '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA').script.toString('hex').slice(0, 6), '76a914');
  assert.equal(readAddress(btc, '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf').script.toString('hex').slice(0, 4), 'a914');
  assert.throws(() => readAddress(btc, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv'), /not a valid Bitcoin/);
  assert.throws(() => readAddress(btc, 'LUWPbpM43E2p7ZSh8cyTBEkvpHmr3cB8Ez'), /not for Bitcoin/);
  assert.ok(readAddress(ltc, 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh'));
  const cash = ref.find((r) => r.name === 'bch-xpub').addrs[0];
  assert.equal(readAddress(bch, cash).address, cash);
  assert.equal(readAddress(bch, cash.split(':')[1]).address, cash);
  assert.equal(readAddress(bch, '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA').address.startsWith('bitcoincash:q'), true);   // old-style BCH address
  assert.throws(() => cashDecode('bitcoincash', cash.slice(0, -1) + 'x'));
  assert.throws(() => segwitDecode('bc', 'tb1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));
});
