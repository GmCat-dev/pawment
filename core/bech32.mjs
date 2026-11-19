// bech32 (BIP-173), as used by Cardano addresses (addr1…, addr_test1…) and account keys (xpub1…, acct_xvk1…).
// Cardano addresses are longer than BIP-173's 90-character limit, so no length limit is applied.
const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
  let c = 1;
  for (const v of values) {
    const b = c >>> 25;
    c = ((c & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= GEN[i];
  }
  return c >>> 0;
}
const hrpExpand = (h) => [...[...h].map((x) => x.charCodeAt(0) >> 5), 0, ...[...h].map((x) => x.charCodeAt(0) & 31)];
function convert(data, from, to, pad) {
  let acc = 0, bits = 0; const out = []; const max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & max); }
    acc &= (1 << bits) - 1;
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & max); } else if (bits >= from || ((acc << (to - bits)) & max)) throw new Error('bad padding');
  return out;
}
/** @returns {{hrp: string, data: Buffer}} throws on a bad checksum or character */
export function decode(s) {
  const str = String(s).trim();
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error('mixed case');
  const low = str.toLowerCase();
  const pos = low.lastIndexOf('1');
  if (pos < 1 || pos + 7 > low.length) throw new Error('bad bech32');
  const hrp = low.slice(0, pos);
  const d = [...low.slice(pos + 1)].map((x) => { const i = CH.indexOf(x); if (i < 0) throw new Error('bad character'); return i; });
  if (polymod([...hrpExpand(hrp), ...d]) !== 1) throw new Error('bad checksum');
  return { hrp, data: Buffer.from(convert(d.slice(0, -6), 5, 8, false)) };
}
export function encode(hrp, bytes) {
  const d = convert([...bytes], 8, 5, true);
  const c = polymod([...hrpExpand(hrp), ...d, 0, 0, 0, 0, 0, 0]) ^ 1;
  return hrp + '1' + [...d, ...[0, 1, 2, 3, 4, 5].map((i) => (c >> (5 * (5 - i))) & 31)].map((x) => CH[x]).join('');
}
