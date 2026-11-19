// settings.json: everything a project owner chooses. Read at start and re-read when the admin page saves it.
// Nothing shop-specific lives in the core: each owner's choices (featured coin, discounts, logo) are just values here.
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs';

export const DEFAULTS = {
  name: 'Pawment',
  public_url: 'http://127.0.0.1:4197',
  network: 'mainnet',            // or "testnet" (Cardano preprod): play money for trying things out
  brand: { logo: '', accent: '#6b4fd8', theme: '', support_url: '', terms_url: '', privacy_url: '' },   // theme: a file in public/themes/ (e.g. "night")
  quote_minutes: 30,             // how long a coin price is held once the buyer picks a coin
  grace_hours: 24,               // a payment that arrives this late still completes at the held price
  order_hours: 72,               // an order nobody starts paying is closed after this long
  tolerance_percent: 1.5,        // paid within this much of the price = paid
  refund_days: 7,                // how long after paying a buyer can ask for a refund
  gap_budget: 15,                // most unused fresh addresses handed out at once (wallets stop looking after 20)
  featured: '',                  // coin shown first and pre-selected (any coin id, or empty)
  coins: [],                     // see coin fields below
  sites: {},                     // per-site overrides: { "<site id>": { name, featured, coins: { "<coin id>": { enabled, discount, … } } } }
  email_alerts: { to: '', from: '' },
  coming_soon: false,            // true: the public sees a teaser page; everything else needs the preview code
};
// coin fields: id, chain, unit ("lovelace" or policy+asset hex), decimals, name, symbol, kind ("native" | "stable" | "token"),
//   price: {fixed: 1} | {feeds: ["coingecko:cardano", "kraken:ADAUSD"]} | {pool: "minswap"}
//   enabled (default true), discount (percent, default 0), badge, from / until (YYYY-MM-DD, discount dates), min_usd, step (tidy rounding, in units)

const COIN_ID = /^[A-Za-z0-9]{2,12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throws an Error with a plain-words message if something is wrong; returns the cleaned settings. */
export function validate(raw) {
  const s = { ...DEFAULTS, ...raw, brand: { ...DEFAULTS.brand, ...(raw.brand || {}) }, email_alerts: { ...DEFAULTS.email_alerts, ...(raw.email_alerts || {}) } };
  if (s.analytics_origin && !/^https:\/\/[a-z0-9.-]{3,100}$/.test(s.analytics_origin)) throw new Error('analytics_origin must be like "https://stats.example.com"');
  if (s.brand.theme && !/^[a-z0-9-]{1,30}$/.test(s.brand.theme)) throw new Error('brand.theme must be a theme file name like "my-shop"');
  if (!['mainnet', 'testnet'].includes(s.network)) throw new Error('network must be "mainnet" or "testnet"');
  for (const k of ['quote_minutes', 'grace_hours', 'order_hours', 'refund_days', 'gap_budget']) {
    if (!(Number.isInteger(s[k]) && s[k] >= 0 && s[k] <= 10000)) throw new Error(`${k} must be a whole number`);
  }
  if (s.gap_budget > 18) throw new Error('gap_budget must stay below 19, or wallets may stop showing payments');
  if (!(s.tolerance_percent >= 0 && s.tolerance_percent <= 10)) throw new Error('tolerance_percent must be between 0 and 10');
  const seen = new Set();
  s.coins = (s.coins || []).map((c) => {
    if (!COIN_ID.test(c.id || '')) throw new Error(`coin id "${c.id}" must be 2-12 letters or digits`);
    if (seen.has(c.id)) throw new Error(`coin "${c.id}" is listed twice`);
    seen.add(c.id);
    if (!c.chain || !c.unit) throw new Error(`coin "${c.id}" needs a chain and a unit`);
    if (!(Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 18)) throw new Error(`coin "${c.id}": decimals must be 0-18`);
    checkDiscount(c, c.id);
    if (!c.price || !(c.price.fixed > 0 || Array.isArray(c.price.feeds) || c.price.pool || c.price.token)) throw new Error(`coin "${c.id}" needs a price source`);
    return { enabled: true, discount: 0, kind: 'token', ...c };
  });
  if (s.featured && !seen.has(s.featured)) throw new Error(`featured coin "${s.featured}" is not in the coin list`);
  for (const [id, site] of Object.entries(s.sites || {})) {
    if (!/^[a-z0-9-]{2,30}$/.test(id)) throw new Error(`site id "${id}" must be 2-30 lowercase letters, digits or dashes`);
    if (site.featured && !seen.has(site.featured)) throw new Error(`site "${id}": featured coin "${site.featured}" is not in the coin list`);
    for (const [cid, o] of Object.entries(site.coins || {})) {
      if (!seen.has(cid)) throw new Error(`site "${id}": coin "${cid}" is not in the coin list`);
      checkDiscount(o, `${id}/${cid}`);
    }
  }
  return s;
}
function checkDiscount(c, label) {
  if (c.discount !== undefined && !(Number(c.discount) >= 0 && Number(c.discount) <= 90)) throw new Error(`${label}: discount must be 0-90 percent`);
  for (const k of ['from', 'until']) if (c[k] && !DATE.test(c[k])) throw new Error(`${label}: ${k} must look like 2026-12-01`);
  if (c.min_usd !== undefined && !(Number(c.min_usd) >= 0)) throw new Error(`${label}: min_usd must be a number`);
}

export function load(path) {
  return validate(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
}
/** Save after checking, keeping the previous file as settings.json.bak. */
export function save(path, s) {
  const clean = validate(s);
  if (existsSync(path)) copyFileSync(path, path + '.bak');
  writeFileSync(path + '.tmp', JSON.stringify(clean, null, 2) + '\n', { mode: 0o640 });
  renameSync(path + '.tmp', path);
  return clean;
}

const today = (t) => new Date(t * 1000).toISOString().slice(0, 10);
/**
 * The coins a buyer can pick for one order, in display order, with the discount that applies now.
 * Featured coin first, then the order of the coin list. Site overrides win over the main list.
 */
export function coinsFor(s, { site = '', usd = 0, discounts = true, only = null, at = Math.floor(Date.now() / 1000) } = {}) {
  const o = s.sites?.[site] || {};
  const featured = o.featured || s.featured;
  const day = today(at);
  const list = [];
  for (const base of s.coins) {
    const c = { ...base, ...(o.coins?.[base.id] || {}) };
    if (!c.enabled) continue;
    if (only && !only.includes(c.id)) continue;
    if (c.min_usd && usd < c.min_usd) continue;
    const dated = (!c.from || day >= c.from) && (!c.until || day <= c.until);
    const discount = discounts && dated ? Number(c.discount) || 0 : 0;
    list.push({ ...c, discount, badge: discount ? c.badge || `Save ${discount}%` : '', featured: c.id === featured });
  }
  list.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
  return list;
}
