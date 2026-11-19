// Watch-only Cardano addresses from an account PUBLIC key (CIP-1852, BIP32-Ed25519 non-hardened derivation).
// The account public key can make receiving addresses but can never spend. Ported from an earlier Python version.
import { createHmac } from 'node:crypto';
import { blake2b } from '../core/blake2b.mjs';
import * as bech32 from '../core/bech32.mjs';

import { add, mul, decompress, compress, le, B } from '../core/ed25519.mjs';

/** Non-hardened child of a 64-byte extended public key (key | chain code). */
export function derivePublic(xpub, index) {
  if (!(Number.isInteger(index) && index >= 0 && index < 2 ** 31)) throw new Error('public derivation needs a non-hardened index');
  const a = xpub.subarray(0, 32), c = xpub.subarray(32, 64);
  const i = Buffer.alloc(4); i.writeUInt32LE(index);
  const z = createHmac('sha512', c).update(Buffer.concat([Buffer.from([2]), a, i])).digest();
  const zl = le(z.subarray(0, 28));
  const child = compress(add(decompress(a), mul(8n * zl, B)));
  const cc = createHmac('sha512', c).update(Buffer.concat([Buffer.from([3]), a, i])).digest().subarray(32);
  return Buffer.concat([child, cc]);
}

/** Accepts "xpub1…", "acct_xvk1…" or 128 hex characters. Refuses anything that looks like a private key. */
export function parseAccountKey(s) {
  const str = String(s || '').trim();
  if (/^(xprv|acct_xsk|addr_xsk|root_xsk|ed25519e?_sk)/i.test(str)) throw new Error('That is a PRIVATE key. Never paste it anywhere; only the public one is needed.');
  let raw;
  if (/^(xpub1|acct_xvk1)/i.test(str)) raw = bech32.decode(str).data;
  else if (/^[0-9a-f]{128}$/i.test(str)) raw = Buffer.from(str, 'hex');
  else throw new Error('An account public key starts with xpub1 or acct_xvk1, or is 128 hex characters.');
  if (raw.length !== 64) throw new Error('An account public key is 64 bytes.');
  decompress(raw.subarray(0, 32));
  return raw;
}

const h224 = (b) => blake2b(b, 28);
/** Base address (payment key role 0 / index, stake key role 2 / 0), mainnet "addr1…" or testnet "addr_test1…". */
export function baseAddress(accountXpub, index, { network = 1, role = 0 } = {}) {
  const pay = derivePublic(derivePublic(accountXpub, role), index).subarray(0, 32);
  const stake = derivePublic(derivePublic(accountXpub, 2), 0).subarray(0, 32);
  return bech32.encode(network === 1 ? 'addr' : 'addr_test', Buffer.concat([Buffer.from([network & 15]), h224(pay), h224(stake)]));
}

/** A Cardano address a person typed: checksum, prefix and network. Returns the normalised address or throws. */
export function checkAddress(addr, { network = 1 } = {}) {
  const s = String(addr || '').trim();
  const want = network === 1 ? 'addr' : 'addr_test';
  let d;
  try { d = bech32.decode(s); } catch { throw new Error('That is not a valid Cardano address (a letter may be wrong or missing).'); }
  if (d.hrp !== want) throw new Error(network === 1 ? 'That address is for a test network, not real Cardano.' : 'That is a real (mainnet) address; this is the test network.');
  const kind = d.data[0] >> 4;
  if ((d.data[0] & 15) !== (network === 1 ? 1 : 0)) throw new Error('That address is for a different Cardano network.');
  if (kind > 7) throw new Error('That kind of Cardano address cannot receive payments.');
  return s.toLowerCase();
}
