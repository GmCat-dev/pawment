// Groestl-512 (SHA-3 finalist), used by Groestlcoin for base58 checksums (addresses and extended keys).
// Plain byte-matrix implementation; only a few short inputs are ever hashed, so speed doesn't matter.
// Checked against groestl-hash-js (the library Groestlcoin's own JavaScript wallet code uses) in the tests.
const SBOX = (() => {
  const s = new Uint8Array(256);
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    s[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  return s;
})();
const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = (a << 1) ^ (a & 0x80 ? 0x11b : 0); b >>= 1; } return r & 0xff; };
const C = [2, 2, 3, 4, 5, 3, 5, 7];
const SHIFT_P = [0, 1, 2, 3, 4, 5, 6, 11], SHIFT_Q = [1, 3, 5, 11, 0, 2, 4, 6];
const COLS = 16, ROUNDS = 14;

// state: 128 bytes, byte k = row (k % 8), column (k >> 3)
function perm(state, isQ) {
  let a = Uint8Array.from(state);
  for (let r = 0; r < ROUNDS; r++) {
    for (let j = 0; j < COLS; j++) {
      if (isQ) { for (let i = 0; i < 8; i++) a[j * 8 + i] ^= 0xff; a[j * 8 + 7] ^= (j << 4) ^ r; }
      else a[j * 8] ^= (j << 4) ^ r;
    }
    for (let k = 0; k < 128; k++) a[k] = SBOX[a[k]];
    const sh = isQ ? SHIFT_Q : SHIFT_P, b = new Uint8Array(128);
    for (let i = 0; i < 8; i++) for (let j = 0; j < COLS; j++) b[j * 8 + i] = a[((j + sh[i]) % COLS) * 8 + i];
    const m = new Uint8Array(128);
    for (let j = 0; j < COLS; j++) for (let i = 0; i < 8; i++) {
      let v = 0;
      for (let k = 0; k < 8; k++) v ^= mul(C[(k - i + 8) % 8], b[j * 8 + k]);
      m[j * 8 + i] = v;
    }
    a = m;
  }
  return a;
}

/** Groestl-512 of a Buffer/Uint8Array -> 64-byte Buffer */
export function groestl512(input) {
  const msg = Buffer.from(input);
  const blocks = Math.floor((msg.length + 9 + 127) / 128);
  const padded = Buffer.alloc(blocks * 128);
  msg.copy(padded); padded[msg.length] = 0x80;
  padded.writeBigUInt64BE(BigInt(blocks), padded.length - 8);
  let h = new Uint8Array(128); h[126] = 0x02; h[127] = 0x00;   // IV encodes the 512-bit output length
  for (let o = 0; o < padded.length; o += 128) {
    const m = padded.subarray(o, o + 128);
    const hm = h.map((x, k) => x ^ m[k]);
    const p = perm(hm, false), q = perm(m, true);
    h = h.map((x, k) => x ^ p[k] ^ q[k]);
  }
  const p = perm(h, false);
  return Buffer.from(h.map((x, k) => x ^ p[k]).subarray(64));
}
/** Groestlcoin's checksum hash: Groestl-512 applied twice */
export const groestl512d = (b) => groestl512(groestl512(b));
