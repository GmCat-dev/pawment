// Small helpers shared by the core and the chain plug-ins.
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

const B32 = 'abcdefghijkmnpqrstuvwxyz23456789';   // no l, o, 0, 1: easy to read out loud
/** Random id like "ord_k3m9…" (5 bits per character). 20 characters = 100 bits: unguessable, so it can be a private link. */
export function makeId(prefix, length = 20) {
  const bytes = randomBytes(length);
  let s = '';
  for (let i = 0; i < length; i++) s += B32[bytes[i] & 31];
  return prefix + '_' + s;
}
export const ID_RE = /^[a-z]{2,6}_[a-z2-9]{12,40}$/;

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const hmac = (key, s) => createHmac('sha256', String(key)).update(String(s)).digest('hex');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Amounts are whole numbers of the coin's smallest unit (lovelace, satoshi, …), kept as BigInt in code and TEXT in the database. */
export const big = (v) => (typeof v === 'bigint' ? v : BigInt(String(v ?? '0').split('.')[0] || '0'));
/** "12.5" with 6 decimals -> 12500000n (rounds up: a buyer is never asked for less than the price). */
export function toUnits(amount, decimals) {
  const [w, f = ''] = String(amount).split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  let n = BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
  if (/[1-9]/.test(f.slice(decimals))) n += 1n;
  return n;
}
/** 12500000n with 6 decimals -> "12.5" */
export function fromUnits(n, decimals) {
  n = big(n);
  const neg = n < 0n; if (neg) n = -n;
  const d = 10n ** BigInt(decimals);
  const w = n / d, f = (n % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + w.toString() + (f ? '.' + f : '');
}
/** Coin amount for a dollar price, rounded UP to `step` units (so amounts are tidy, e.g. 0.01 ADA). */
export function usdToUnits(usd, priceUsd, decimals, step = 1n) {
  if (!(priceUsd > 0)) throw new Error('no price');
  // exact BigInt maths (coins with 18 decimals are far beyond floating-point precision): ceil(usd / price * 10^decimals)
  const usdM = BigInt(Math.round(usd * 1e6)), priceP = BigInt(Math.round(priceUsd * 1e12));
  if (priceP === 0n) throw new Error('price too small');
  const num = usdM * 10n ** BigInt(decimals) * 1000000n;
  let n = num / priceP + (num % priceP ? 1n : 0n);
  if (step > 1n && n % step) n += step - (n % step);
  return n;
}

export const now = () => Math.floor(Date.now() / 1000);
export const clampText = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
export const round2 = (x) => Math.round(x * 100) / 100;
