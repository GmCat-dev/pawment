// Watch-only addresses for the Bitcoin family (BTC, LTC, BCH, Ergon, Groestlcoin) from an extended PUBLIC key
// (xpub / ypub / zpub / Ltub / Mtub …). BIP32 public derivation on secp256k1, receive branch m/0/i.
// The key can make receiving addresses but can never spend. No dependencies: BigInt maths + Node's crypto.
import { createHash, createHmac } from 'node:crypto';

// ---------------------------------------------------------------- secp256k1 (Jacobian coordinates)
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => ((a % m) + m) % m;
function pow(b, e, m = P) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
const inv = (a) => pow(a, P - 2n);
function jDouble([x, y, z]) {
  if (y === 0n || z === 0n) return [0n, 1n, 0n];
  const s = mod(4n * x * y * y), m = mod(3n * x * x), x3 = mod(m * m - 2n * s);
  return [x3, mod(m * (s - x3) - 8n * y ** 4n), mod(2n * y * z)];
}
function jAdd(p, q) {
  if (p[2] === 0n) return q; if (q[2] === 0n) return p;
  const [x1, y1, z1] = p, [x2, y2, z2] = q;
  const z1z1 = z1 * z1 % P, z2z2 = z2 * z2 % P;
  const u1 = x1 * z2z2 % P, u2 = x2 * z1z1 % P, s1 = y1 * z2 * z2z2 % P, s2 = y2 * z1 * z1z1 % P;
  if (u1 === u2) return s1 === s2 ? jDouble(p) : [0n, 1n, 0n];
  const h = mod(u2 - u1), r = mod(s2 - s1), hh = h * h % P, hhh = h * hh % P, v = u1 * hh % P;
  const x3 = mod(r * r - hhh - 2n * v);
  return [x3, mod(r * (v - x3) - s1 * hhh), z1 * z2 % P * h % P];
}
function jMul(k, [x, y]) {
  let r = [0n, 1n, 0n], a = [x, y, 1n];
  while (k > 0n) { if (k & 1n) r = jAdd(r, a); a = jDouble(a); k >>= 1n; }
  return r;
}
function toAffine([x, y, z]) { const zi = inv(z), zi2 = zi * zi % P; return [x * zi2 % P, y * zi2 % P * zi % P]; }
const hex32 = (n) => n.toString(16).padStart(64, '0');
function compress([x, y]) { return Buffer.concat([Buffer.from([y & 1n ? 3 : 2]), Buffer.from(hex32(x), 'hex')]); }
function decompress(b) {
  if (b.length !== 33 || (b[0] !== 2 && b[0] !== 3)) throw new Error('not a compressed public key');
  const x = BigInt('0x' + b.subarray(1).toString('hex'));
  if (x >= P) throw new Error('bad point');
  let y = pow(mod(x ** 3n + 7n), (P + 1n) / 4n);
  if (mod(y * y - (x ** 3n + 7n)) !== 0n) throw new Error('not a curve point');
  if ((y & 1n) !== BigInt(b[0] & 1)) y = P - y;
  return [x, y];
}

// ---------------------------------------------------------------- hashes and encodings
export const sha256 = (b) => createHash('sha256').update(b).digest();
export const hash160 = (b) => createHash('ripemd160').update(sha256(b)).digest();
const sha256d = (b) => sha256(sha256(b));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(buf) {
  let n = BigInt('0x' + (buf.toString('hex') || '0')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of buf) { if (byte === 0) s = '1' + s; else break; }
  return s;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad character'); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const lead = str.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(lead), n ? Buffer.from(hex, 'hex') : Buffer.alloc(0)]);
}
/** base58check; `check` is the checksum hash (double SHA-256 for most coins, Groestl for Groestlcoin) */
export function b58check(payload, check = sha256d) { return b58encode(Buffer.concat([payload, check(payload).subarray(0, 4)])); }
export function b58uncheck(str, check = sha256d) {
  const raw = b58decode(String(str).trim());
  if (raw.length < 5) throw new Error('too short');
  const body = raw.subarray(0, -4);
  if (!check(body).subarray(0, 4).equals(raw.subarray(-4))) throw new Error('bad checksum');
  return body;
}

// bech32 / bech32m (BIP-173/350) for SegWit addresses
const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v) { const G5 = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= G5[i]; } return c >>> 0; }
const hrpx = (h) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];
function bits(data, from, to, pad) { let acc = 0, n = 0; const out = []; const max = (1 << to) - 1; for (const v of data) { acc = (acc << from) | v; n += from; while (n >= to) { n -= to; out.push((acc >> n) & max); } acc &= (1 << n) - 1; } if (pad) { if (n) out.push((acc << (to - n)) & max); } else if (n >= from || ((acc << (to - n)) & max)) throw new Error('bad padding'); return out; }
export function segwitEncode(hrp, version, program) {
  const data = [version, ...bits([...program], 8, 5, true)];
  const k = version === 0 ? 1 : 0x2bc830a3;
  const c = polymod([...hrpx(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ k;
  return hrp + '1' + [...data, ...[0, 1, 2, 3, 4, 5].map((i) => (c >> (5 * (5 - i))) & 31)].map((x) => CH[x]).join('');
}
export function segwitDecode(hrp, addr) {
  const s = String(addr).trim();
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('mixed case');
  const low = s.toLowerCase(), pos = low.lastIndexOf('1');
  if (low.slice(0, pos) !== hrp) throw new Error('wrong prefix');
  const d = [...low.slice(pos + 1)].map((c) => { const i = CH.indexOf(c); if (i < 0) throw new Error('bad character'); return i; });
  const pm = polymod([...hrpx(hrp), ...d]);
  const version = d[0];
  if (pm !== (version === 0 ? 1 : 0x2bc830a3)) throw new Error('bad checksum');
  const program = Buffer.from(bits(d.slice(1, -6), 5, 8, false));
  if (version > 16 || program.length < 2 || program.length > 40 || (version === 0 && program.length !== 20 && program.length !== 32)) throw new Error('bad program');
  return { version, program };
}

// CashAddr (Bitcoin Cash, Ergon)
function cashPolymod(v) {
  const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of v) { const c0 = c >> 35n; c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d); for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i]; }
  return c ^ 1n;
}
const cashPrefix = (p) => [...[...p].map((c) => c.charCodeAt(0) & 31), 0];
export function cashEncode(prefix, type, hash) {   // type 0 = P2PKH, 1 = P2SH; hash = 20 bytes (or 32 for P2SH32)
  const size = hash.length === 32 ? 3 : 0;
  const payload = bits([(type << 3) | size, ...hash], 8, 5, true);
  const mod5 = cashPolymod([...cashPrefix(prefix), ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
  const check = [...Array(8)].map((_, i) => Number((mod5 >> BigInt(5 * (7 - i))) & 31n));
  return prefix + ':' + [...payload, ...check].map((x) => CH[x]).join('');
}
export function cashDecode(prefix, addr) {
  let s = String(addr).trim().toLowerCase();
  if (!s.includes(':')) s = prefix + ':' + s;
  const [p, body] = s.split(':');
  if (p !== prefix) throw new Error('wrong prefix');
  const d = [...body].map((c) => { const i = CH.indexOf(c); if (i < 0) throw new Error('bad character'); return i; });
  if (cashPolymod([...cashPrefix(p), ...d]) !== 0n) throw new Error('bad checksum');
  const raw = Buffer.from(bits(d.slice(0, -8), 5, 8, false));
  const size = raw[0] & 7;
  if (!((size === 0 && raw.length === 21) || (size === 3 && raw.length === 33))) throw new Error('unsupported length');
  return { type: raw[0] >> 3, hash: raw.subarray(1) };
}

// ---------------------------------------------------------------- BIP32
/** Non-hardened child of {key (33-byte compressed point), chain (32 bytes)} */
export function ckdPub({ key, chain }, i) {
  if (!(Number.isInteger(i) && i >= 0 && i < 2 ** 31)) throw new Error('public derivation needs a non-hardened index');
  const ib = Buffer.alloc(4); ib.writeUInt32BE(i);
  const I = createHmac('sha512', chain).update(Buffer.concat([key, ib])).digest();
  const il = BigInt('0x' + I.subarray(0, 32).toString('hex'));
  if (il >= N) throw new Error('invalid child (try the next index)');
  const pt = jAdd(jMul(il, G), [...decompress(key), 1n]);
  if (pt[2] === 0n) throw new Error('invalid child');
  return { key: compress(toAffine(pt)), chain: I.subarray(32) };
}

/**
 * Read an extended public key. `versions` maps the 4-byte version (hex) to the address type it stands for.
 * Refuses private keys (xprv, zprv, …) with a clear message.
 */
export function parseExtended(str, versions, { check = sha256d } = {}) {
  const s = String(str || '').trim();
  if (/^[a-z]prv|^[A-Z][a-z]prv|^tprv|^[uvy]prv/.test(s)) throw new Error('That is a PRIVATE key. Never paste it anywhere; only the public one (…pub) is needed.');
  let raw;
  try { raw = b58uncheck(s, check); } catch { throw new Error('That extended public key could not be read (a character may be wrong or missing).'); }
  if (raw.length !== 78) throw new Error('That is not an extended public key.');
  const version = raw.subarray(0, 4).toString('hex');
  const type = versions[version];
  if (!type) throw new Error('This kind of key is not for this coin (or is a private key).');
  const key = raw.subarray(45, 78);
  decompress(key);
  return { type, depth: raw[4], key, chain: raw.subarray(13, 45) };
}

/** scriptPubKey for an address type and hash (used for Electrum's script hashes) */
export function scriptFor(type, hash) {
  if (type === 'p2pkh') return Buffer.concat([Buffer.from('76a914', 'hex'), hash, Buffer.from('88ac', 'hex')]);
  if (type === 'p2sh' && hash.length === 32) return Buffer.concat([Buffer.from('aa20', 'hex'), hash, Buffer.from('87', 'hex')]);   // P2SH32 (Bitcoin Cash)
  if (type === 'p2sh') return Buffer.concat([Buffer.from('a914', 'hex'), hash, Buffer.from('87', 'hex')]);
  if (type === 'p2wpkh') return Buffer.concat([Buffer.from('0014', 'hex'), hash]);
  if (type === 'p2wsh') return Buffer.concat([Buffer.from('0020', 'hex'), hash]);
  if (type === 'p2tr') return Buffer.concat([Buffer.from('5120', 'hex'), hash]);
  throw new Error('unknown script type');
}
