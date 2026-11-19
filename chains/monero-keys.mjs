// Monero, watch-only: addresses, subaddresses and "is this output ours, and how much?" from the private VIEW key and
// the public spend key. The view key can see incoming payments but can never spend.
// Follows Monero's own rules (cryptonote / RingCT): Keccak-256 hashes, Ed25519 points, Monero base58, view tags.
import { keccak256 } from '../core/keccak.mjs';
import { L, B, add, neg, mul, le, leBytes, decompress, compress } from '../core/ed25519.mjs';

const NET = {   // address prefixes: standard, subaddress
  mainnet: { std: 18, sub: 42 },
  testnet: { std: 24, sub: 36 },   // our "testnet" = Monero stagenet
};

// ---------------------------------------------------------------- Monero base58 (8-byte blocks -> 11 characters)
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ENC_LEN = [0, 2, 3, 5, 6, 7, 9, 10, 11];
function encBlock(block) {
  let n = 0n; for (const b of block) n = (n << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < ENC_LEN[block.length]; i++) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
  return s;
}
export function b58encode(buf) {
  let s = '';
  for (let o = 0; o < buf.length; o += 8) s += encBlock(buf.subarray(o, Math.min(o + 8, buf.length)));
  return s;
}
export function b58decode(str) {
  const out = [];
  for (let o = 0; o < str.length; o += 11) {
    const chunk = str.slice(o, o + 11), size = ENC_LEN.indexOf(chunk.length);
    if (size < 0) throw new Error('bad length');
    let n = 0n;
    for (const c of chunk) { const i = ALPHA.indexOf(c); if (i < 0) throw new Error('bad character'); n = n * 58n + BigInt(i); }
    if (n >= 1n << BigInt(8 * size)) throw new Error('overflow');
    const block = []; for (let i = 0; i < size; i++) { block.unshift(Number(n & 0xffn)); n >>= 8n; }
    out.push(...block);
  }
  return Buffer.from(out);
}

const varint = (n) => { const out = []; n = BigInt(n); do { let b = Number(n & 0x7fn); n >>= 7n; if (n > 0n) b |= 0x80; out.push(b); } while (n > 0n); return Buffer.from(out); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
/** hash to scalar: Keccak-256 then reduce mod l */
export const hs = (data) => leBytes(le(keccak256(data)) % L);

/** decode an address -> {net, kind: 'std'|'sub'|'integrated', spend (32B), view (32B)} ; checks the checksum */
export function decodeAddress(addr) {
  const s = String(addr || '').trim();
  let raw;
  try { raw = b58decode(s); } catch { throw new Error('That is not a valid Monero address (a character may be wrong or missing).'); }
  if (raw.length < 69) throw new Error('That is not a valid Monero address.');
  const body = raw.subarray(0, -4);
  if (!keccak256(body).subarray(0, 4).equals(raw.subarray(-4))) throw new Error('That Monero address has a typo (its check digits do not match).');
  const prefix = body[0];
  const net = Object.entries(NET).find(([, v]) => v.std === prefix || v.sub === prefix || v.std + 1 === prefix);
  if (!net) throw new Error('That is not a Monero address.');
  const kind = prefix === net[1].sub ? 'sub' : prefix === net[1].std ? 'std' : 'integrated';
  return { net: net[0], kind, spend: body.subarray(1, 33), view: body.subarray(33, 65) };
}
function encodeAddress(prefix, spend, view) {
  const body = Buffer.concat([varint(prefix), spend, view]);
  return b58encode(Buffer.concat([body, keccak256(body).subarray(0, 4)]));
}

/** a watch-only Monero wallet: primary address + private view key (64 hex, little-endian scalar) */
export function moneroWallet(address, viewKeyHex, network = 'mainnet') {
  const a = decodeAddress(address);
  if (a.kind !== 'std') throw new Error('Use the wallet\'s main (primary) address, starting with 4, not a subaddress.');
  if (a.net !== network) throw new Error(network === 'mainnet' ? 'That is a test-network (stagenet) address.' : 'That is a real (mainnet) address; this is the test network.');
  const vk = String(viewKeyHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(vk)) throw new Error('The private view key is 64 letters and numbers (0-9, a-f).');
  const av = le(Buffer.from(vk, 'hex'));
  if (av >= L) throw new Error('That is not a valid view key.');
  if (!compress(mul(av, B)).equals(Buffer.from(a.view))) throw new Error('That view key does not belong to this address. (Make sure you copied the private VIEW key, never the spend key.)');
  const spendPt = decompress(Buffer.from(a.spend));
  const subs = new Map();   // compressed spend key (hex) -> index
  const cache = new Map();  // index -> address
  const nb = NET[network];
  function subaddress(i) {
    if (cache.has(i)) return cache.get(i);
    let addr, D;
    if (i === 0) { addr = encodeAddress(nb.std, a.spend, a.view); D = Buffer.from(a.spend); }
    else {
      const m = le(hs(Buffer.concat([Buffer.from('SubAddr\0'), leBytes(av), u32(0), u32(i)])));
      const Dp = add(spendPt, mul(m, B));
      D = compress(Dp);
      addr = encodeAddress(nb.sub, D, compress(mul(av, Dp)));
    }
    subs.set(D.toString('hex'), i);
    cache.set(i, addr);
    return addr;
  }
  /** an address handed out earlier (e.g. before a restart): recognise it as ours from the address itself */
  function adopt(addr) {
    let d; try { d = decodeAddress(addr); } catch { return false; }
    if (d.net !== network) return false;
    const key = Buffer.from(d.spend).toString('hex');
    if (subs.has(key)) return true;
    if (d.kind === 'std') { if (!Buffer.from(d.spend).equals(Buffer.from(a.spend))) return false; subs.set(key, 0); cache.set(0, addr); return true; }
    if (d.kind !== 'sub') return false;
    let D; try { D = decompress(Buffer.from(d.spend)); } catch { return false; }
    if (!compress(mul(av, D)).equals(Buffer.from(d.view))) return false;   // C = a*D only for our own subaddresses
    subs.set(key, -1);   // ours; its number isn't needed to credit it
    return true;
  }
  return {
    av, address: subaddress, adopt,
    /** the outputs of one transaction (decoded JSON) that belong to this wallet: [{index, sub, amount (BigInt)}] */
    scan(txJson) {
      const extra = txJson.extra || [];
      const keys = parseExtra(extra);
      if (!keys.main && !keys.additional.length) return [];
      const derive = (R) => { try { return compress(mul(8n * av, decompress(R))); } catch { return null; } };
      const dMain = keys.main ? derive(keys.main) : null;
      const found = [];
      (txJson.vout || []).forEach((o, i) => {
        const tk = o.target?.tagged_key || o.target?.key ? (o.target.tagged_key || { key: o.target.key }) : null;
        if (!tk) return;
        const cands = [dMain, keys.additional[i] ? derive(keys.additional[i]) : null].filter(Boolean);
        for (const der of cands) {
          if (tk.view_tag !== undefined) {
            const vt = keccak256(Buffer.concat([Buffer.from('view_tag'), der, varint(i)]))[0];
            if (vt !== parseInt(tk.view_tag, 16)) continue;
          }
          const s = hs(Buffer.concat([der, varint(i)]));
          const Dc = compress(add(decompress(Buffer.from(tk.key, 'hex')), neg(mul(le(s), B))));
          const idx = subs.get(Dc.toString('hex'));
          if (idx === undefined) continue;
          const addr = idx >= 0 ? subaddress(idx) : encodeAddress(nb.sub, Dc, compress(mul(av, decompress(Dc))));
          let amount;
          if (txJson.rct_signatures && txJson.rct_signatures.type > 0) {
            const enc = Buffer.from(txJson.rct_signatures.ecdhInfo[i].amount, 'hex');
            const mask = keccak256(Buffer.concat([Buffer.from('amount'), s])).subarray(0, 8);
            const plain = Buffer.alloc(8); for (let k = 0; k < 8; k++) plain[k] = enc[k] ^ mask[k];
            amount = plain.readBigUInt64LE(0);
          } else amount = BigInt(o.amount || 0);
          found.push({ index: i, sub: idx, address: addr, amount });
          break;
        }
      });
      return found;
    },
  };
}

/** tx extra (array of bytes) -> {main: tx public key, additional: [per-output public keys]} */
export function parseExtra(extra) {
  const b = Buffer.from(extra);
  let o = 0, main = null; const additional = [];
  const rv = () => { let n = 0, s = 0, x; do { x = b[o++]; n |= (x & 0x7f) << s; s += 7; } while (x & 0x80 && o < b.length); return n; };
  while (o < b.length) {
    const tag = b[o++];
    if (tag === 0x01) { if (!main) main = b.subarray(o, o + 32); o += 32; }
    else if (tag === 0x04) { const n = rv(); for (let i = 0; i < n; i++) { additional.push(b.subarray(o, o + 32)); o += 32; } }
    else if (tag === 0x02) { const n = rv(); o += n; }   // nonce (payment id)
    else if (tag === 0x00) { while (o < b.length && b[o] === 0) o++; }   // padding
    else break;   // unknown field: stop (the keys come first in practice)
  }
  return { main, additional };
}
