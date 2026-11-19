// Makes the demo's receiving wallets: TEST-NETWORK public keys/addresses only, from random keys that are thrown away.
// Nobody can spend from them, and test-network coins have no value. Run once: node demo/make-wallets.mjs > demo/wallets.json
import { createECDH, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { b58check, sha256 } from '../chains/btc-keys.mjs';
import { toChecksum } from '../core/keccak.mjs';

function xpub(versionHex) {
  const ec = createECDH('secp256k1'); ec.setPrivateKey(randomBytes(32));
  const key = Buffer.from(ec.getPublicKey(null, 'compressed'));
  return b58check(Buffer.concat([Buffer.from(versionHex, 'hex'), Buffer.from([3]), randomBytes(4), Buffer.from([0x80, 0, 0, 0]), randomBytes(32), key]));
}
const evm = () => toChecksum('0x' + randomBytes(20).toString('hex'));
const tron = () => b58check(Buffer.concat([Buffer.from([0x41]), randomBytes(20)]));
// Cardano preprod + Monero stagenet: the throwaway test wallets made during development (public parts only)
const ada = JSON.parse(readFileSync(new URL('../data/testnet-wallet.json', import.meta.url))).account_xvk;
const xmr = JSON.parse(readFileSync(new URL('../data/stagenet-xmr-test.json', import.meta.url)));
console.log(JSON.stringify({
  note: 'Demo only: test-network public keys from thrown-away random keys. Never send real coins here.',
  cardano: { account_key: ada },
  btc: { account_key: xpub('045f1cf6') },   // vpub (BIP84 testnet)
  ltc: { account_key: xpub('045f1cf6') },
  bch: { account_key: xpub('043587cf') },   // tpub
  eth: { address: evm() }, bsc: { address: evm() }, polygon: { address: evm() },
  trx: { address: tron() },
  xmr: { address: xmr.address, view_key: xmr.view_key },
}, null, 2));
