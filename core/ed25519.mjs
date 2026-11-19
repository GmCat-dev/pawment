// Ed25519 curve maths (extended coordinates, BigInt), shared by the Cardano and Monero plug-ins. Public-key maths only.
export const P = 2n ** 255n - 19n;
export const L = 2n ** 252n + 27742317777372353535851937790883648493n;   // group order
export const mod = (a, m = P) => ((a % m) + m) % m;
export function pow(b, e, m = P) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
export const inv = (x) => pow(x, P - 2n);
const D = mod(-121665n * inv(121666n));
const I = pow(2n, (P - 1n) / 4n);
function xrecover(y) {
  const xx = mod((y * y - 1n) * inv(D * y * y + 1n));
  let x = pow(xx, (P + 3n) / 8n);
  if (mod(x * x - xx) !== 0n) x = x * I % P;
  if (mod(x * x - xx) !== 0n) throw new Error('not a curve point');
  return x;
}
const BY = 4n * inv(5n) % P;
let BX = xrecover(BY); if (BX & 1n) BX = P - BX;
export const B = [BX, BY, 1n, BX * BY % P];
export const ZERO = [0n, 1n, 1n, 0n];
export function add([x1, y1, z1, t1], [x2, y2, z2, t2]) {
  const a = mod((y1 - x1) * (y2 - x2)), b = mod((y1 + x1) * (y2 + x2)), c = mod(t1 * 2n * D * t2), d = mod(z1 * 2n * z2);
  const e = b - a, f = d - c, g = d + c, h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}
export const neg = ([x, y, z, t]) => [mod(-x), y, z, mod(-t)];
export function mul(s, p) { let q = ZERO; while (s > 0n) { if (s & 1n) q = add(q, p); p = add(p, p); s >>= 1n; } return q; }
export const le = (buf) => { let n = 0n; for (let i = buf.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]); return n; };
export function leBytes(n, len = 32) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; }
export function decompress(b) {
  if (b.length !== 32) throw new Error('a point is 32 bytes');
  let y = le(b); const sign = y >> 255n; y &= (1n << 255n) - 1n;
  if (y >= P) throw new Error('not a curve point');
  let x = xrecover(y); if ((x & 1n) !== sign) x = P - x;
  return [x, y, 1n, x * y % P];
}
export function compress([x, y, z]) { const zi = inv(z); x = x * zi % P; y = y * zi % P; return leBytes(y | ((x & 1n) << 255n)); }
