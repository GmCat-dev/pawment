// The payment engine: orders, held prices ("quotes"), receiving addresses, matching payments to orders,
// refunds, and the signed "paid" messages to sites. Chain-specific work is done by the chain plug-ins.
//
// How a payment is tied to its order (safest first):
//   1. own address: an account public key gives each quote a fresh address; whatever arrives there belongs to it.
//   2. shared address + exact amount: when no fresh address is free (or the wallet is a single address), the amount
//      gets a small unique offset, so no two waiting orders on one address share an amount.
//   3. "I already paid": the buyer pastes a transaction id and it is looked up.
// Anything that can't be tied to an order safely goes to "Payments to check" for a person to decide.
import { makeId, big, fromUnits, toUnits, usdToUnits, clampText, round2, hmac, now as clock } from './util.mjs';
import { coinsFor } from './settings.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets(id INTEGER PRIMARY KEY, chain TEXT NOT NULL, spec TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, retired INTEGER);
CREATE TABLE IF NOT EXISTS addresses(address TEXT PRIMARY KEY, chain TEXT NOT NULL, wallet_id INTEGER NOT NULL, idx INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'free', quote_id TEXT, held_until INTEGER, used INTEGER NOT NULL DEFAULT 0, scanned INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS addresses_wallet ON addresses(wallet_id, state, idx);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, site TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', item TEXT NOT NULL DEFAULT '',
  usd REAL NOT NULL, notify_url TEXT NOT NULL DEFAULT '', return_url TEXT NOT NULL DEFAULT '', discounts INTEGER NOT NULL DEFAULT 1,
  only_coins TEXT, status TEXT NOT NULL DEFAULT 'open', check_reason TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL,
  paid_at INTEGER, paid_quote TEXT, test INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, created);
CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY, order_id TEXT NOT NULL, coin TEXT NOT NULL, chain TEXT NOT NULL, unit TEXT NOT NULL,
  decimals INTEGER NOT NULL, list_usd REAL NOT NULL, discount REAL NOT NULL, usd REAL NOT NULL, price_usd REAL NOT NULL, amount TEXT NOT NULL,
  address TEXT NOT NULL, shared INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, grace_until INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS quotes_order ON quotes(order_id, created);
CREATE INDEX IF NOT EXISTS quotes_address ON quotes(address, grace_until);
CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, ref TEXT NOT NULL, chain TEXT NOT NULL, tx TEXT NOT NULL, address TEXT NOT NULL,
  unit TEXT NOT NULL, amount TEXT NOT NULL, block_height INTEGER, seen_at INTEGER NOT NULL, confirmed_at INTEGER,
  order_id TEXT, quote_id TEXT, state TEXT NOT NULL, reason TEXT, second INTEGER, usd REAL);
CREATE INDEX IF NOT EXISTS payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS payments_state ON payments(state, seen_at);
CREATE TABLE IF NOT EXISTS refunds(id TEXT PRIMARY KEY, order_id TEXT NOT NULL, coin TEXT NOT NULL, unit TEXT NOT NULL, chain TEXT NOT NULL,
  decimals INTEGER NOT NULL, amount TEXT NOT NULL, kind TEXT NOT NULL, address TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested', created INTEGER NOT NULL, decided_at INTEGER, sent_at INTEGER, tx TEXT, admin_note TEXT, sent_amount TEXT);
CREATE INDEX IF NOT EXISTS refunds_order ON refunds(order_id);
CREATE TABLE IF NOT EXISTS notices(id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, site TEXT NOT NULL, event TEXT NOT NULL, url TEXT NOT NULL,
  body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE TABLE IF NOT EXISTS log(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chain_state(chain TEXT PRIMARY KEY, state TEXT NOT NULL, saved INTEGER NOT NULL);
`;

export class PayError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.code = code; this.status = status; }
}

const RETRY = [60, 300, 1800, 7200, 21600, 43200, 86400];   // seconds between tries of a "paid" message to a site
const OPEN = ['open', 'seen', 'part_paid'];
const RECYCLE_AFTER = 3 * 86400;   // an unpaid fresh address goes back to the pool this long after its grace period (very late payments stay safe)
const WATCH_AFTER = 7 * 86400;     // addresses are still watched this long after the grace period, for late payments

/**
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db
 * @param {() => object} o.settings current settings
 * @param {Record<string, any>} o.chains chain plug-ins by id
 * @param {{get: (id: string) => any}} o.prices
 * @param {(site: string) => {webhook_secret: string}|null} o.siteSecret
 * @param {(url: string, init: object) => Promise<Response>} [o.post] for "paid" messages
 * @param {(subject: string, text: string) => Promise<void>} [o.alert] urgent emails to the owner
 */
export function createEngine({ db, settings, chains, prices, siteSecret, post = fetch, alert = async () => {}, now = clock, log = console.log }) {
  db.exec(SCHEMA);
  try { db.exec('ALTER TABLE refunds ADD COLUMN sent_amount TEXT'); } catch { /* already there */ }
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const note = (kind, detail) => run('INSERT INTO log(at, kind, detail) VALUES(?, ?, ?)', now(), kind, typeof detail === 'string' ? detail : JSON.stringify(detail));
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const S = () => settings();
  const health = {};   // chain id -> {ok_at, error, error_at, tip}
  const restored = new Set();   // chains whose saved reading position has been loaded
  /** an email to the owner about something that needs them (never blocks, never throws) */
  const tell = (subject, text) => { Promise.resolve().then(() => alert(S().name + ': ' + subject, text + '\n\nOpen the dashboard (Needs you) to deal with it.')).catch((err) => log('alert failed: ' + err.message)); };

  // ---------------------------------------------------------------- wallets
  function activeWallet(chain) {
    const w = one('SELECT * FROM wallets WHERE chain = ? AND active = 1', chain);
    if (!w) return null;
    return { ...w, impl: chains[chain].wallet(JSON.parse(w.spec)) };
  }
  /** Check a receiving wallet without saving it: what kind it is and its first addresses (so the owner can compare with their wallet app). */
  function previewWallet(chain, spec) {
    const c = chains[chain];
    if (!c) throw new PayError('bad_chain', 'Unknown chain.');
    let w;
    try { w = c.wallet(cleanSpec(spec)); } catch (e) { throw new PayError('bad_wallet', e.message); }
    return { chain, kind: w.kind, label: w.label, first_addresses: w.kind === 'account' ? [0, 1, 2].map((i) => w.address(i)) : [w.address(0)] };
  }
  const cleanSpec = (spec) => (spec?.account_key ? { account_key: String(spec.account_key).trim() }
    : spec?.view_key ? { address: String(spec.address || '').trim(), view_key: String(spec.view_key).trim() }   // Monero: primary address + private view key
    : { address: String(spec?.address || '').trim() });
  /** Change the receiving wallet. New orders use it at once; orders already waiting keep their address and are still watched. */
  async function setWallet(chain, spec, { by = 'admin' } = {}) {
    const p = previewWallet(chain, spec);
    const w = chains[chain].wallet(cleanSpec(spec));
    const old = one('SELECT * FROM wallets WHERE chain = ? AND active = 1', chain);
    if (old && old.fingerprint === w.fingerprint) return { ...p, changed: false };
    tx(() => {
      if (old) run('UPDATE wallets SET active = 0, retired = ? WHERE id = ?', now(), old.id);
      run('INSERT INTO wallets(chain, spec, fingerprint, kind, label, created) VALUES(?, ?, ?, ?, ?, ?)', chain, JSON.stringify(cleanSpec(spec)), w.fingerprint, w.kind, w.label, now());
      // free addresses of the old wallet are never handed out again
      if (old) run("UPDATE addresses SET state = 'retired' WHERE wallet_id = ? AND state = 'free'", old.id);
    });
    note('wallet', { chain, kind: w.kind, first: p.first_addresses[0], by });
    await alert(`URGENT: ${S().name} receiving wallet for ${chains[chain].name} was ${old ? 'changed' : 'set'}`,
      `The ${chains[chain].name} receiving wallet was ${old ? 'changed' : 'set'} (${w.label}).\nFirst address: ${p.first_addresses[0]}\n\n` +
      `If you did not do this, change it back at once in the admin page: new payments would go to this wallet.`).catch((e) => log('alert failed: ' + e.message));
    return { ...p, changed: true };
  }

  // ---------------------------------------------------------------- orders
  /** A site asks for a payment. Prices are in US dollars. */
  function createOrder(site, input) {
    const usd = round2(Number(input.amount));
    if (String(input.currency || 'USD').toUpperCase() !== 'USD') throw new PayError('bad_currency', 'Only USD prices for now.');
    if (!(usd >= 0.5 && usd <= 100000)) throw new PayError('bad_amount', 'The amount must be between 0.50 and 100000 USD.');
    const urlOk = (u) => !u || /^https?:\/\/[^\s]{3,300}$/.test(u);
    if (!urlOk(input.notify_url) || !urlOk(input.return_url)) throw new PayError('bad_url', 'notify_url and return_url must be http(s) links.');
    const only = Array.isArray(input.coins) ? input.coins.map(String).slice(0, 40) : null;
    if (!coinsFor(S(), { site, usd, only }).length) throw new PayError('no_coins', 'No coin can be used for this order (check the coin list and minimums).');
    const id = makeId('ord');
    run(`INSERT INTO orders(id, site, ref, item, usd, notify_url, return_url, discounts, only_coins, created, expires, test)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, site, clampText(input.ref, 120), clampText(input.item, 140), usd,
    input.notify_url || '', input.return_url || '', input.discounts === false ? 0 : 1, only ? JSON.stringify(only) : null,
    now(), now() + S().order_hours * 3600, S().network === 'testnet' ? 1 : 0);
    return siteView(id);
  }

  const getOrder = (id) => one('SELECT * FROM orders WHERE id = ?', String(id));
  const quotesOf = (id) => all('SELECT * FROM quotes WHERE order_id = ? ORDER BY created', id);
  const paymentsOf = (id) => all("SELECT * FROM payments WHERE order_id = ? AND state IN ('seen', 'counted', 'check') ORDER BY seen_at", id);

  /** Totals per quote: confirmed and waiting amounts (BigInt). */
  function totals(o) {
    const t = {};
    for (const p of paymentsOf(o.id)) {
      if (!p.quote_id) continue;
      const x = (t[p.quote_id] ||= { confirmed: 0n, waiting: 0n });
      if (p.state === 'counted') x.confirmed += big(p.amount); else if (p.state === 'seen') x.waiting += big(p.amount);
    }
    return t;
  }

  function coinView(c) {
    return { id: c.id, name: c.name, symbol: c.symbol || c.id, chain: c.chain, chain_name: chains[c.chain]?.name || c.chain, kind: c.kind, discount: c.discount, badge: c.badge, featured: c.featured, decimals: c.decimals,
      available: Boolean(prices.get(c.id)) && Boolean(chains[c.chain]) && Boolean(one('SELECT 1 FROM wallets WHERE chain = ? AND active = 1', c.chain)) };
  }
  function quoteView(q, t = {}) {
    const c = chains[q.chain];
    const amount = big(q.amount), conf = t.confirmed || 0n, wait = t.waiting || 0n;
    const left = amount > conf ? amount - conf : 0n;
    return {
      id: q.id, coin: q.coin, symbol: symbolOf(q.coin), decimals: q.decimals, chain: q.chain, chain_name: c?.name || q.chain, token: Boolean(c && q.unit !== (c.nativeUnit || 'lovelace')), address: q.address, amount: fromUnits(amount, q.decimals), units: q.amount, usd: q.usd, list_usd: q.list_usd, discount: q.discount,
      price_usd: q.price_usd, expires_at: q.expires, grace_until: q.grace_until, shared: Boolean(q.shared),
      covered: (conf + wait) * 10000n >= amount * BigInt(Math.round((100 - S().tolerance_percent) * 100)),
      received: fromUnits(conf, q.decimals), waiting: fromUnits(wait, q.decimals), left: fromUnits(left, q.decimals),
      uri: c ? c.paymentUri(q.address, { unit: q.unit }, left || amount) : q.address,
      left_uri: c && conf > 0n && left > 0n ? c.paymentUri(q.address, { unit: q.unit }, left) : null,
      pay: c?.payInfo ? c.payInfo(q.unit) : null,
    };
  }

  /** What the buyer's page shows. The order id is the private link: no other secret is needed to see it. */
  function publicView(id) {
    const o = getOrder(id);
    if (!o) throw new PayError('not_found', 'This payment link does not exist.', 404);
    const s = S();
    const qs = quotesOf(o.id), t = totals(o);
    const latest = qs.at(-1) || null;
    const paidQ = o.paid_quote ? qs.find((q) => q.id === o.paid_quote) : null;
    const pays = paymentsOf(o.id).map((p) => {
      const q = qs.find((x) => x.id === p.quote_id);
      return { tx: p.tx, coin: q?.coin || '', symbol: q ? symbolOf(q.coin) : '', decimals: q ? q.decimals : 0, amount: q ? fromUnits(p.amount, q.decimals) : p.amount, state: p.state, seen_at: p.seen_at, confirmed_at: p.confirmed_at,
        explorer: chains[p.chain]?.explorer(p.tx) || '' };
    });
    const extra = paidQ ? big(t[paidQ.id]?.confirmed || 0n) - big(paidQ.amount) : 0n;
    const refunds = all('SELECT * FROM refunds WHERE order_id = ? ORDER BY created', o.id).map((r) => ({
      id: r.id, coin: r.coin, symbol: symbolOf(r.coin), decimals: r.decimals, amount: fromUnits(r.sent_amount || r.amount, r.decimals), kind: r.kind, address: r.address, status: r.status, created: r.created, tx: r.tx,
      explorer: r.tx ? chains[r.chain]?.explorer(r.tx) || '' : '' }));
    const firstPaid = pays.find((p) => p.state === 'counted')?.confirmed_at || o.paid_at;
    const refundUntil = firstPaid ? firstPaid + s.refund_days * 86400 : null;
    const site = s.sites?.[o.site] || {};
    return {
      id: o.id, site: site.name || o.site, item: o.item, usd: o.usd, status: o.status, created: o.created, expires_at: o.expires, paid_at: o.paid_at,
      return_url: o.return_url || site.return_url || '', test: Boolean(o.test), network: s.network,
      coins: OPEN.includes(o.status) && !paidQ ? coinsFor(s, { site: o.site, usd: o.usd, discounts: Boolean(o.discounts), only: o.only_coins ? JSON.parse(o.only_coins) : null, at: now() })
        .map((c) => ({ ...coinView(c), usd: round2(Math.max(0.01, o.usd * (100 - c.discount) / 100)) })) : [],
      quote: (paidQ || latest) ? quoteView(paidQ || latest, t[(paidQ || latest).id]) : null,
      payments: pays, extra: !refunds.some((r) => r.status === 'sent') && extra > 0n && paidQ && extra * 1000n > big(paidQ.amount) * BigInt(Math.round(s.tolerance_percent * 10)) ? fromUnits(extra, paidQ.decimals) : null,
      refunds, refund_until: refundUntil, can_refund: Boolean(refundUntil && now() <= refundUntil && !refunds.some((r) => ['requested', 'approved', 'sent'].includes(r.status))),
      minutes_per_block: latest ? chains[latest.chain]?.minutesPerBlock : null, blocks_needed: latest ? chains[latest.chain]?.depthNeeded(latest.usd) : null,
      brand: { name: s.name, ...s.brand },
    };
  }
  /** What the site that made the order is told (also the body of "paid" messages). */
  function siteView(id) {
    const o = getOrder(id);
    if (!o) throw new PayError('not_found', 'No such order.', 404);
    const q = o.paid_quote ? one('SELECT * FROM quotes WHERE id = ?', o.paid_quote) : null;
    const t = q ? totals(o)[q.id] : null;
    const refunds = all("SELECT status, amount, decimals, coin, kind FROM refunds WHERE order_id = ? AND status = 'sent'", o.id);
    return {
      id: o.id, site: o.site, ref: o.ref, item: o.item, amount: o.usd.toFixed(2), currency: 'USD', status: o.status, test: Boolean(o.test),
      created: o.created, paid_at: o.paid_at, checkout_url: S().public_url.replace(/\/$/, '') + '/o/' + o.id,
      payment: q ? { coin: q.coin, amount: fromUnits(t?.confirmed || 0n, q.decimals), price_amount: fromUnits(q.amount, q.decimals), paid_usd: q.usd, discount: q.discount,
        txs: all("SELECT DISTINCT tx FROM payments WHERE quote_id = ? AND state = 'counted'", q.id).map((r) => r.tx) } : null,
      refunded: refunds.map((r) => ({ coin: r.coin, amount: fromUnits(r.amount, r.decimals), kind: r.kind })),
    };
  }

  // ---------------------------------------------------------------- quotes and addresses
  /** Hand out a receiving address for a quote: a fresh one if possible, else a shared one (then the amount gets an offset). */
  function holdAddress(chain, quoteId, until) {
    const w = activeWallet(chain);
    if (!w) throw new PayError('no_wallet', 'This coin is not set up yet.', 503);
    if (w.kind === 'account') {
      // only addresses already checked on the chain (empty, never seen with money) are handed out: see topUpPool
      const free = one("SELECT address FROM addresses WHERE wallet_id = ? AND state = 'free' AND used = 0 AND scanned = 1 ORDER BY idx LIMIT 1", w.id);
      if (free) {
        run("UPDATE addresses SET state = 'held', quote_id = ?, held_until = ? WHERE address = ?", quoteId, until, free.address);
        return { address: free.address, shared: false };
      }
      // no checked fresh address ready (busy moment, or just set up): share the least busy held one, else the main address
      const busy = one(`SELECT a.address FROM addresses a LEFT JOIN quotes q ON q.address = a.address AND q.grace_until > ?
        WHERE a.wallet_id = ? AND a.used = 0 AND a.state = 'held' GROUP BY a.address ORDER BY COUNT(q.id), a.idx LIMIT 1`, now(), w.id);
      if (busy) return { address: busy.address, shared: true };
      const main = w.impl.address(0);
      run("INSERT OR IGNORE INTO addresses(address, chain, wallet_id, idx, state, scanned) VALUES(?, ?, ?, 0, 'main', 1)", main, chain, w.id);
      return { address: main, shared: true };
    }
    const address = w.impl.address(0);
    run("INSERT OR IGNORE INTO addresses(address, chain, wallet_id, idx, state, scanned) VALUES(?, ?, ?, 0, 'single', 1)", address, chain, w.id);
    return { address, shared: true };
  }
  /** Offset (in units) so this amount differs from every other waiting quote for the same coin on the same address. */
  /** a power-of-ten step (in units) worth at most `usd` dollars at this price (at least 1 unit) */
  function stepWorth(usd, priceUsd, decimals) {
    const unitUsd = priceUsd / 10 ** decimals;
    const e = Math.floor(Math.log10(usd / unitUsd));
    return e > 0 ? 10n ** BigInt(Math.min(e, 30)) : 1n;
  }
  function uniqueAmount(address, unit, base, decimals, step) {
    // keep the extra tiny: up to 99 small steps (about a cent) first; only if that many orders are waiting on this
    // address at once, widen to 999, then 9999 steps
    const taken = new Set(all('SELECT amount FROM quotes WHERE address = ? AND unit = ? AND grace_until > ?', address, unit, now()).map((r) => r.amount));
    for (const [max, tries] of [[99, 300], [999, 500], [9999, 1000]]) {
      for (let t = 0; t < tries; t++) {
        const amt = base + BigInt(1 + Math.floor(Math.random() * max)) * step;
        if (!taken.has(amt.toString())) return amt;
      }
    }
    throw new PayError('busy', 'Too many payments are waiting right now. Please try again in a few minutes.', 503);
  }


  /** The buyer picked a coin: hold its price for quote_minutes and give the amount and address. */
  function quote(orderId, coinId) {
    const o = getOrder(orderId);
    if (!o) throw new PayError('not_found', 'This payment link does not exist.', 404);
    if (!OPEN.includes(o.status)) throw new PayError('closed', 'This order is no longer waiting for a payment.', 409);
    const s = S();
    const coin = coinsFor(s, { site: o.site, usd: o.usd, discounts: Boolean(o.discounts), only: o.only_coins ? JSON.parse(o.only_coins) : null, at: now() }).find((c) => c.id === coinId);
    if (!coin) throw new PayError('bad_coin', 'That coin can not be used for this order.');
    const t = totals(o);
    const qs = quotesOf(o.id);
    // something already arrived: the buyer must finish in the same coin (shown as "send the rest")
    const started = qs.find((q) => (t[q.id]?.confirmed || 0n) + (t[q.id]?.waiting || 0n) > 0n);
    if (started) {
      if (started.coin !== coinId) throw new PayError('started', `A payment in ${started.coin} has already arrived for this order. Please finish in ${started.coin}.`, 409);
      return publicView(o.id);
    }
    const live = qs.filter((q) => q.expires > now() + 60);
    const same = live.find((q) => q.coin === coinId);
    if (same) return publicView(o.id);   // asking again shows the same held price
    if (qs.length >= 12) throw new PayError('too_many', 'This order has been re-priced too many times. Please start a new one.', 429);
    const price = prices.get(coinId);
    if (!price) throw new PayError('no_price', `We can't get a reliable ${coin.symbol || coin.id} price right now. Please pick another coin or try again soon.`, 503);
    if (!chains[coin.chain]) throw new PayError('no_chain', 'This coin is not set up yet.', 503);
    const usd = round2(Math.max(0.01, o.usd * (100 - coin.discount) / 100));
    // tidy amounts (rounded up to about a cent's worth) and unique offsets (about a tenth of a cent each), whatever the coin is worth
    const step = coin.step ? BigInt(coin.step) : stepWorth(0.01, price.usd, coin.decimals);
    const base = usdToUnits(usd, price.usd, coin.decimals, step);
    const offStep = stepWorth(0.0001, price.usd, coin.decimals);   // each unique step is worth about a hundredth of a cent
    const id = makeId('q', 16);
    const expires = now() + s.quote_minutes * 60, grace = expires + s.grace_hours * 3600;
    tx(() => {
      const { address, shared } = holdAddress(coin.chain, id, grace);
      const amount = shared ? uniqueAmount(address, coin.unit, base, coin.decimals, offStep) : base;
      run(`INSERT INTO quotes(id, order_id, coin, chain, unit, decimals, list_usd, discount, usd, price_usd, amount, address, shared, created, expires, grace_until)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, o.id, coin.id, coin.chain, coin.unit, coin.decimals, o.usd, coin.discount, usd, price.usd,
      amount.toString(), address, shared ? 1 : 0, now(), expires, grace);
      // a buyer who switches coin before paying: the earlier fresh address stays held until its grace ends (a late payment still counts)
    });
    return publicView(o.id);
  }

  // ---------------------------------------------------------------- watching the chains
  /** Record one output (once per output and coin). Decides which quote it belongs to. */
  function record(chainId, row, { quotesByAddress, scanning }) {
    const chain = chains[chainId];
    const units = Object.entries(row.amounts);
    // tokens first: the main coin that rides along with a token payment (Cardano's min-ADA) is decided after we know where the token went
    const native = chain.nativeUnit || 'lovelace';
    units.sort(([a], [b]) => (a === native) - (b === native));
    let tokenMatched = null;
    for (const [unit, amount] of units) {
      const pid = row.ref + '|' + unit;
      const had = one('SELECT block_height FROM payments WHERE id = ?', pid);
      if (had) {
        // seen while still waiting (Bitcoin-style mempool); now it's in a block
        if (had.block_height == null && row.block_height != null) run('UPDATE payments SET block_height = ? WHERE id = ?', row.block_height, pid);
        continue;
      }
      const base = { id: pid, ref: row.ref, chain: chainId, tx: row.tx, address: row.address, unit, amount: amount.toString(), block_height: row.block_height, seen_at: now() };
      const ins = (state, quote, reason = null) => run(`INSERT INTO payments(id, ref, chain, tx, address, unit, amount, block_height, seen_at, order_id, quote_id, state, reason)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, base.id, base.ref, chainId, base.tx, base.address, unit, base.amount, base.block_height, base.seen_at,
      quote?.order_id || null, quote?.id || null, state, reason);
      if (scanning) { ins('baseline', null, 'already there before this address was used for orders'); continue; }
      const candidates = (quotesByAddress.get(row.address) || []).filter((q) => q.unit === unit);
      let q = null, reason = null;
      const own = candidates.find((c) => !c.shared);
      if (own) q = own;
      else q = candidates.find((c) => c.amount === base.amount) || null;
      if (q) {
        if (unit !== native) tokenMatched = q;
        const late = now() > q.grace_until;
        ins(late ? 'check' : 'seen', q, late ? 'arrived after the grace period' : null);
        if (late) flagOrder(q.order_id, 'A payment arrived after the grace period.');
        continue;
      }
      if (unit === native && tokenMatched) { ins('carried', tokenMatched, 'main coin sent along with the token'); continue; }
      const any = quotesByAddress.get(row.address) || [];
      if (unit !== native && !s_coinByUnit(unit)) { ins('ignored', null, 'a token we do not take'); continue; }
      if (unit === native && units.length > 1 && !tokenMatched) { ins('ignored', null, 'main coin sent along with an unmatched token'); continue; }
      // money on an address that only orders use: always worth a look. On a shared single address, only amounts close to a waiting order.
      const dist = (c) => { const d = big(base.amount) - big(c.amount); return d < 0n ? -d : d; };
      const near = any.filter((c) => c.unit === unit && withinPct(big(base.amount), big(c.amount), 10) && getOrder(c.order_id)?.status !== 'paid' && !one("SELECT 1 FROM payments WHERE quote_id = ? AND state IN ('seen', 'counted')", c.id))
        .sort((x, y) => (dist(x) < dist(y) ? -1 : dist(x) > dist(y) ? 1 : 0))[0];
      const fresh = one("SELECT state FROM addresses WHERE address = ? AND state != 'single'", row.address);
      if (fresh || near) {
        reason = near ? 'amount does not match any waiting order exactly' : 'payment to an order address with no matching order';
        ins('check', near || null, reason);
        if (!near) { const cn = s_coinByUnit(unit); tell('a payment to check', fromUnits(big(base.amount), cn?.decimals ?? 0) + ' ' + (cn?.symbol || unit) + ' arrived on ' + (chain?.name || chainId) + ' (' + reason + ').'); }
        if (near) flagOrder(near.order_id, 'A payment arrived with an amount that does not match exactly.');
      } else ins('other', null, 'not an order payment');
      void chain;
    }
  }
  const s_coinByUnit = (unit) => S().coins.find((c) => c.unit === unit);
  const symbolOf = (id) => S().coins.find((c) => c.id === id)?.symbol || id;
  const withinPct = (a, b, pct) => (a > b ? a - b : b - a) * 100n <= b * BigInt(pct);

  function flagOrder(orderId, reason) {
    const changed = run("UPDATE orders SET status = 'check', check_reason = ? WHERE id = ? AND status IN ('open', 'seen', 'part_paid', 'expired')", reason, orderId).changes;
    if (changed) { const o = getOrder(orderId); tell('a payment needs you', 'Order "' + (o.item || o.id) + '" ($' + o.usd.toFixed(2) + ', ' + o.site + '): ' + reason); }
  }

  /** Re-work an order's status from its payments. Sends "paid" once. */
  function evaluate(orderId) {
    const o = getOrder(orderId);
    if (!o || ['paid', 'cancelled'].includes(o.status)) return;
    const s = S();
    const t = totals(o);
    const qs = quotesOf(o.id);
    const tolNum = BigInt(Math.round((100 - s.tolerance_percent) * 100));
    let status = 'open', paidQ = null, partial = 0;
    for (const q of qs) {
      const x = t[q.id];
      if (!x) continue;
      if (x.confirmed > 0n && x.confirmed * 10000n >= big(q.amount) * tolNum) { paidQ = q; break; }
      if (x.confirmed > 0n) partial++;
      if (x.confirmed > 0n && status !== 'part_paid') status = 'part_paid';
      else if (x.waiting > 0n && status === 'open') status = 'seen';
    }
    if (paidQ) {
      run("UPDATE orders SET status = 'paid', paid_at = ?, paid_quote = ?, check_reason = NULL WHERE id = ? AND status != 'paid'", now(), paidQ.id, o.id);
      note('paid', { order: o.id, coin: paidQ.coin, usd: paidQ.usd });
      queueNotice(o.id, 'order.paid');
      return;
    }
    if (partial > 1) return flagOrder(o.id, 'Part payments arrived in more than one coin.');
    if (o.status === 'check') return;
    const lastGrace = Math.max(0, ...qs.map((q) => q.grace_until));
    if (status === 'part_paid' && now() > lastGrace) return flagOrder(o.id, 'Only part of the price was paid and the rest never came.');
    if (status === 'open' && now() > o.expires && now() > lastGrace) status = 'expired';
    if (status !== o.status) run('UPDATE orders SET status = ? WHERE id = ?', status, o.id);
  }

  /**
   * Keep a few fresh addresses ready. Each new one is first looked at on the chain (in the sweep): if money is already
   * there, the owner has used it in their wallet app, so it is marked used and skipped. Never more than gap_budget
   * unused addresses past the last used one, so wallet apps (which stop looking after 20 empty ones) see every payment.
   */
  function topUpPool(chainId, ready = 4) {
    const w = activeWallet(chainId);
    if (!w || w.kind !== 'account') return;
    let have = one("SELECT COUNT(*) AS n FROM addresses WHERE wallet_id = ? AND state IN ('free', 'new') AND used = 0", w.id).n;
    while (have < ready) {
      const top = one('SELECT MAX(idx) AS m FROM addresses WHERE wallet_id = ?', w.id).m ?? 0;
      const lastUsed = one('SELECT MAX(idx) AS m FROM addresses WHERE wallet_id = ? AND used = 1', w.id).m ?? 0;
      if (top + 1 - lastUsed > S().gap_budget) break;
      const idx = top + 1;   // index 0 is the wallet's own main address: only used as a shared fallback
      run("INSERT OR IGNORE INTO addresses(address, chain, wallet_id, idx, state) VALUES(?, ?, ?, ?, 'new')", w.impl.address(idx), chainId, w.id, idx);
      have++;
    }
  }

  /**
   * What the privacy policy promises: orders nobody paid are deleted after 90 days; paid orders, payments and refunds
   * after 7 years (tax records); payments that were never an order payment after 90 days. Runs once a day.
   */
  let lastPrune = 0;
  function prune() {
    if (now() - lastPrune < 86400) return 0;
    lastPrune = now();
    const unpaidBefore = now() - 90 * 86400, paidBefore = now() - 7 * 365 * 86400;
    const gone = all(`SELECT id FROM orders WHERE (status IN ('open', 'expired', 'cancelled') AND created < ?
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id AND p.state IN ('seen', 'counted', 'check')))
      OR (created < ?)`, unpaidBefore, paidBefore).map((r) => r.id);
    tx(() => {
      for (const id of gone) {
        run('DELETE FROM payments WHERE order_id = ?', id);
        run('DELETE FROM refunds WHERE order_id = ?', id);
        run('DELETE FROM notices WHERE order_id = ?', id);
        run('DELETE FROM quotes WHERE order_id = ?', id);
        run('DELETE FROM orders WHERE id = ?', id);
      }
      run("DELETE FROM payments WHERE order_id IS NULL AND state IN ('other', 'ignored', 'baseline') AND seen_at < ?", unpaidBefore);
      run('DELETE FROM log WHERE at < ?', paidBefore);
    });
    if (gone.length) note('prune', { orders: gone.length });
    return gone.length;
  }

  /** One pass: look at every address that matters, record new outputs, count confirmed ones, tidy up. */
  async function sweep({ wide = false } = {}) {
    for (const [chainId, chain] of Object.entries(chains)) {
      try {
        // where this chain's reader stopped (kept across restarts, so payments made meanwhile aren't missed)
        if (chain.importState && !restored.has(chainId)) {
          const row = one('SELECT state, saved FROM chain_state WHERE chain = ?', chainId);
          if (row) { try { chain.importState(JSON.parse(row.state), { savedAt: row.saved, now: now() }); } catch (err) { log('state ' + chainId + ': ' + err.message); } }
          restored.add(chainId);
        }
        topUpPool(chainId);
        const tip = await chain.tip();
        const watchQuotes = all('SELECT * FROM quotes WHERE chain = ? AND grace_until > ?', chainId, now() - 7 * 86400);
        const quotesByAddress = new Map();
        for (const q of watchQuotes.sort((a, b) => b.created - a.created)) {   // newest first: a recycled address belongs to its latest quote
          if (!quotesByAddress.has(q.address)) quotesByAddress.set(q.address, []);
          quotesByAddress.get(q.address).push(q);
        }
        const addrs = new Set(watchQuotes.filter((q) => q.grace_until > now() - WATCH_AFTER).map((q) => q.address));
        for (const a of all("SELECT address FROM addresses WHERE chain = ? AND scanned = 0", chainId)) addrs.add(a.address);
        if (wide) for (const a of all("SELECT address FROM addresses WHERE chain = ? AND state != 'retired' OR (chain = ? AND used = 1)", chainId, chainId)) addrs.add(a.address);
        // refund addresses waiting for the owner's refund
        const refundWatch = all("SELECT * FROM refunds WHERE chain = ? AND status = 'approved'", chainId);
        for (const r of refundWatch) addrs.add(r.address);
        // first look at a never-scanned address: what is already there is not an order payment
        const fresh = new Set(all("SELECT address FROM addresses WHERE chain = ? AND scanned = 0", chainId).map((r) => r.address));
        const rows = addrs.size ? await chain.incoming([...addrs]) : [];
        for (const row of rows) {
          if (refundWatch.some((r) => r.address === row.address)) { checkRefundOutput(row); continue; }
          // a fresh address that was handed out before it was ever scanned: an output there that's newer than the quote is a payment
          record(chainId, row, { quotesByAddress, scanning: fresh.has(row.address) && !quotesByAddress.has(row.address) });
        }
        for (const a of fresh) {
          if (!addrs.has(a)) continue;
          const had = rows.some((r) => r.address === a);
          run(`UPDATE addresses SET scanned = 1, used = CASE WHEN ? THEN 1 ELSE used END, state = CASE WHEN state = 'new' THEN (CASE WHEN ? THEN 'done' ELSE 'free' END) ELSE state END WHERE address = ?`, had ? 1 : 0, had ? 1 : 0, a);
        }
        // confirmations
        for (const p of all("SELECT p.*, q.usd AS qusd, q.coin AS qcoin FROM payments p JOIN quotes q ON q.id = p.quote_id WHERE p.chain = ? AND p.state = 'seen'", chainId)) {
          if (p.block_height == null) continue;
          if (tip - p.block_height + 1 < chain.depthNeeded(p.qusd)) continue;
          const second = await chain.confirm(p.ref, p.address, p.unit, p.amount);
          if (second === false) {
            run("UPDATE payments SET state = 'check', reason = 'the two blockchain services disagree about this payment', second = 0 WHERE id = ?", p.id);
            flagOrder(p.order_id, 'The two blockchain services disagree about a payment.');
            continue;
          }
          run("UPDATE payments SET state = 'counted', confirmed_at = ?, second = ? WHERE id = ?", now(), second === null ? null : 1, p.id);
          run('UPDATE addresses SET used = 1 WHERE address = ?', p.address);
          evaluate(p.order_id);
        }
        health[chainId] = { ...health[chainId], ok_at: now(), tip, error: null, error_since: null, alerted: false, watching: addrs.size };
        if (chain.exportState) run('INSERT INTO chain_state(chain, state, saved) VALUES(?, ?, ?) ON CONFLICT(chain) DO UPDATE SET state = excluded.state, saved = excluded.saved', chainId, JSON.stringify(chain.exportState()), now());
      } catch (e) {
        const h = health[chainId] || {};
        const since = h.error ? (h.error_since || now()) : now();
        health[chainId] = { ...h, error: e.message, error_at: now(), error_since: since };
        log('sweep ' + chainId + ': ' + e.message);
        if (now() - since > 1800 && !h.alerted) {
          health[chainId].alerted = true;
          tell(chain.name + ' watcher is not working', S().name + ' has not been able to read ' + chain.name + ' for over 30 minutes (' + e.message + '). Payments made meanwhile are found once it works again; buyers may see "waiting" longer.');
        }
      }
    }
    // addresses whose quote is over (grace passed) with nothing received go back to the pool
    run(`UPDATE addresses SET state = 'free', quote_id = NULL, held_until = NULL WHERE state = 'held' AND held_until < ? AND used = 0`, now() - RECYCLE_AFTER);
    run(`UPDATE addresses SET state = 'done' WHERE state = 'held' AND used = 1`);
    for (const o of all("SELECT id FROM orders WHERE status IN ('open', 'seen', 'part_paid')")) evaluate(o.id);
    await sendNotices();
    prune();
  }

  /** "I already paid": look up a transaction the buyer pasted. */
  async function claim(orderId, txId) {
    const o = getOrder(orderId);
    if (!o) throw new PayError('not_found', 'This payment link does not exist.', 404);
    const raw = String(txId || '').trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(raw)) throw new PayError('bad_tx', 'A transaction ID is 64 letters and numbers (0-9, a-f), sometimes starting with 0x. Copy it from your wallet\'s history.');
    const qs = quotesOf(o.id);
    if (!qs.length) throw new PayError('no_quote', 'Pick a coin first, so we know where to look.');
    const isEvm = qs.some((q) => chains[q.chain]?.nativeUnit === 'wei');
    const id = isEvm ? '0x' + raw : raw;   // Ethereum-style ids are written with 0x
    const known = one('SELECT order_id, state FROM payments WHERE tx = ? AND order_id IS NOT NULL LIMIT 1', id);
    if (known && known.order_id === o.id) return { found: true, message: 'We already have this payment. It counts once it is confirmed.', view: publicView(o.id) };
    if (known) throw new PayError('other_order', 'That payment belongs to a different order.', 409);
    const chainIds = [...new Set(qs.map((q) => q.chain))];
    let outputs = null;
    for (const c of chainIds) { outputs = await chains[c].transaction(id); if (outputs) { outputs.chain = c; break; } }
    if (!outputs) return { found: false, message: 'That transaction is not on the blockchain yet. If you just sent it, wait a minute and try again.' };
    const quotesByAddress = new Map();
    for (const q of qs) { if (!quotesByAddress.has(q.address)) quotesByAddress.set(q.address, []); quotesByAddress.get(q.address).push(q); }
    const ours = outputs.filter((r) => quotesByAddress.has(r.address));
    if (!ours.length) {
      note('claim_miss', { order: o.id, tx: id });
      return { found: false, message: 'That transaction did not send anything to this order\'s address. If you think it should count, ask for help: we have noted it.' };
    }
    for (const r of ours) record(outputs.chain, r, { quotesByAddress, scanning: false });
    evaluate(o.id);
    return { found: true, message: 'Found it. It counts once it is confirmed (usually a few minutes).', view: publicView(o.id) };
  }

  // ---------------------------------------------------------------- refunds
  function requestRefund(orderId, { address, note: text }) {
    const v = publicView(orderId);
    if (!v.can_refund) throw new PayError('no_refund', v.refund_until && now() > v.refund_until ? `Refunds can be asked for up to ${S().refund_days} days after paying.` : 'A refund can not be asked for on this order right now.', 409);
    const q = one('SELECT * FROM quotes WHERE id = ?', getOrder(orderId).paid_quote) || one("SELECT q.* FROM quotes q JOIN payments p ON p.quote_id = q.id WHERE q.order_id = ? AND p.state = 'counted' LIMIT 1", orderId);
    if (!q) throw new PayError('no_refund', 'Nothing has been received for this order yet.', 409);
    let clean;
    try { clean = chains[q.chain].checkAddress(address); } catch (e) { throw new PayError('bad_address', e.message); }
    const t = totals(getOrder(orderId))[q.id];
    const o = getOrder(orderId);
    const kind = o.status === 'paid' && v.extra ? 'extra' : o.status === 'paid' ? 'full' : 'all_received';
    const amount = kind === 'extra' ? big(t.confirmed) - big(q.amount) : big(t.confirmed);
    const id = makeId('rf', 16);
    run(`INSERT INTO refunds(id, order_id, coin, unit, chain, decimals, amount, kind, address, note, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, orderId, q.coin, q.unit, q.chain, q.decimals, amount.toString(), kind, clean, clampText(text, 500), now());
    note('refund_request', { order: orderId, refund: id });
    tell('refund asked for', fromUnits(amount, q.decimals) + ' ' + symbolOf(q.coin) + ' for order "' + (o.item || o.id) + '" ($' + o.usd.toFixed(2) + ', ' + o.site + '). Refund address: ' + clean + (text ? '\nBuyer says: ' + clampText(text, 300) : ''));
    return publicView(orderId);
  }
  /** the refund arriving on the buyer's address: the network fee comes out of it, so anything from half to the full amount counts */
  function checkRefundOutput(row) {
    for (const r of all("SELECT * FROM refunds WHERE status = 'approved' AND address = ?", row.address)) {
      const got = row.amounts[r.unit] || 0n, want = big(r.amount);
      if (got > 0n && got * 2n >= want && got * 100n <= want * 102n && !one('SELECT 1 FROM refunds WHERE tx = ?', row.tx)) markRefundSent(r.id, row.tx, got);
    }
  }
  function markRefundSent(id, txId, sentAmount = null) {
    const r = one('SELECT * FROM refunds WHERE id = ?', id);
    run("UPDATE refunds SET status = 'sent', sent_at = ?, tx = ?, sent_amount = ? WHERE id = ?", now(), txId, sentAmount === null ? null : sentAmount.toString(), id);
    note('refund_sent', { refund: id, tx: txId });
    queueNotice(r.order_id, 'order.refunded');
  }

  // ---------------------------------------------------------------- "paid" messages to sites
  function queueNotice(orderId, event) {
    const o = getOrder(orderId);
    const url = o.notify_url || S().sites?.[o.site]?.notify_url;
    if (!url) return;
    const body = JSON.stringify({ event, at: now(), order: siteView(orderId) });
    run('INSERT INTO notices(order_id, site, event, url, body, next_at) VALUES(?, ?, ?, ?, ?, ?)', orderId, o.site, event, url, body, now());
  }
  /** Signed like: Pawment-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the site's webhook secret> */
  async function sendNotices() {
    for (const n of all('SELECT * FROM notices WHERE done = 0 AND next_at <= ? ORDER BY id LIMIT 20', now())) {
      const secret = siteSecret(n.site)?.webhook_secret;
      const t = now();
      let ok = false, err = '';
      if (!secret) err = 'site has no webhook secret';
      else {
        try {
          const r = await post(n.url, { method: 'POST', headers: { 'content-type': 'application/json', 'pawment-signature': `t=${t},v1=${hmac(secret, t + '.' + n.body)}`, 'user-agent': 'Pawment/1' },
            body: n.body, signal: AbortSignal.timeout(10000), redirect: 'manual' });
          ok = r.status >= 200 && r.status < 300;
          if (!ok) err = 'site answered ' + r.status;
        } catch (e) { err = e.message; }
      }
      if (ok) run('UPDATE notices SET done = 1, attempts = attempts + 1, last_error = NULL WHERE id = ?', n.id);
      else {
        const wait = RETRY[Math.min(n.attempts, RETRY.length - 1)];
        run('UPDATE notices SET attempts = attempts + 1, next_at = ?, last_error = ?, done = ? WHERE id = ?', now() + wait, clampText(err, 200), n.attempts + 1 >= 20 ? 2 : 0, n.id);
      }
    }
  }

  // ---------------------------------------------------------------- owner (admin) side
  function adminOrders({ filter = 'all', limit = 200 } = {}) {
    const where = { all: '1 = 1', action: "status = 'check'", paid: "status = 'paid'", waiting: "status IN ('open', 'seen', 'part_paid')" }[filter] || '1 = 1';
    return all(`SELECT * FROM orders WHERE ${where} ORDER BY created DESC LIMIT ?`, Math.min(1000, limit)).map((o) => {
      const q = o.paid_quote ? one('SELECT coin, amount, decimals, usd FROM quotes WHERE id = ?', o.paid_quote) : one('SELECT coin, amount, decimals, usd FROM quotes WHERE order_id = ? ORDER BY created DESC LIMIT 1', o.id);
      return { id: o.id, site: S().sites?.[o.site]?.name || o.site, ref: o.ref, item: o.item, usd: o.usd, status: o.status, check_reason: o.check_reason, created: o.created, paid_at: o.paid_at,
        coin: q ? symbolOf(q.coin) : null, coin_amount: q ? fromUnits(q.amount, q.decimals) : null, decimals: q ? q.decimals : null, paid_usd: q?.usd ?? null, test: Boolean(o.test) };
    });
  }
  function adminOrder(id) {
    const o = getOrder(id);
    if (!o) throw new PayError('not_found', 'No such order.', 404);
    return { order: o, view: publicView(id), quotes: quotesOf(id), payments: all('SELECT * FROM payments WHERE order_id = ? ORDER BY seen_at', id).map(withExplorer),
      refunds: all('SELECT * FROM refunds WHERE order_id = ? ORDER BY created', id), notices: all('SELECT id, event, attempts, done, last_error, next_at FROM notices WHERE order_id = ?', id) };
  }
  const withExplorer = (p) => {
    const coin = S().coins.find((c) => c.chain === p.chain && c.unit === p.unit);
    return { ...p, explorer: chains[p.chain]?.explorer(p.tx) || '', chain_name: chains[p.chain]?.name || p.chain, coin: coin?.id || null, symbol: coin?.symbol || coin?.id || p.unit, decimals: coin?.decimals ?? 0 };
  };
  const toCheck = () => ({
    orders: adminOrders({ filter: 'action' }),
    payments: all("SELECT * FROM payments WHERE state = 'check' ORDER BY seen_at DESC LIMIT 200").map(withExplorer),
    refunds: all("SELECT * FROM refunds WHERE status IN ('requested', 'approved') ORDER BY created").map((r) => ({
      ...r, symbol: symbolOf(r.coin), chain_name: chains[r.chain]?.name || r.chain, uri: chains[r.chain] ? chains[r.chain].paymentUri(r.address, { unit: r.unit }, big(r.amount)) : r.address })),
  });
  /** Owner decisions. Every one is written to the log. */
  function adminAction(kind, id, input = {}) {
    note('admin_' + kind, { id, ...input });
    switch (kind) {
      case 'accept': {   // count an order as paid (e.g. part paid but close enough, or a late payment)
        const o = getOrder(id);
        if (!o) throw new PayError('not_found', 'No such order.', 404);
        const q = one("SELECT q.* FROM quotes q JOIN payments p ON p.quote_id = q.id WHERE q.order_id = ? AND p.state IN ('counted', 'check') ORDER BY q.created DESC LIMIT 1", id)
          || quotesOf(id).at(-1);
        if (!q) throw new PayError('no_quote', 'This order has no payment to accept.', 409);
        run("UPDATE payments SET state = 'counted', confirmed_at = COALESCE(confirmed_at, ?) WHERE order_id = ? AND state = 'check'", now(), id);
        run("UPDATE orders SET status = 'paid', paid_at = ?, paid_quote = ?, check_reason = NULL WHERE id = ?", now(), q.id, id);
        queueNotice(id, 'order.paid');
        return adminOrder(id);
      }
      case 'dismiss': {   // a payment to check that is not an order payment (e.g. a gift)
        run("UPDATE payments SET state = 'other', reason = ? WHERE id = ? AND state = 'check'", 'marked not an order payment by the owner', id);
        return toCheck();
      }
      case 'attach': {   // tie a payment to check to an order
        const p = one('SELECT * FROM payments WHERE id = ?', id);
        const q = p && quotesOf(String(input.order_id || '')).filter((x) => x.unit === p.unit).at(-1);
        if (!q) throw new PayError('bad_order', 'That order has no price in this coin.', 409);
        run("UPDATE payments SET order_id = ?, quote_id = ?, state = 'counted', confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?", q.order_id, q.id, now(), id);
        run("UPDATE orders SET status = 'open' WHERE id = ? AND status IN ('check', 'expired')", q.order_id);
        evaluate(q.order_id);
        return adminOrder(q.order_id);
      }
      case 'reopen': {   // clear a "check" flag and let the order go on waiting
        run("UPDATE orders SET status = 'open', check_reason = NULL WHERE id = ? AND status = 'check'", id);
        evaluate(id);
        return adminOrder(id);
      }
      case 'cancel': {
        run("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status != 'paid'", id);
        return adminOrder(id);
      }
      case 'refund_approve':
      case 'refund_decline': {
        const r = one("SELECT * FROM refunds WHERE id = ? AND status = 'requested'", id);
        if (!r) throw new PayError('not_found', 'No refund request waiting with that id.', 404);
        run('UPDATE refunds SET status = ?, decided_at = ?, admin_note = ? WHERE id = ?', kind === 'refund_approve' ? 'approved' : 'declined', now(), clampText(input.note, 300), id);
        return adminOrder(r.order_id);
      }
      case 'refund_sent': {   // the owner pasted the transaction they sent the refund with
        const r = one("SELECT * FROM refunds WHERE id = ? AND status IN ('approved', 'requested')", id);
        if (!r) throw new PayError('not_found', 'No approved refund with that id.', 404);
        let t = String(input.tx || '').trim().toLowerCase();
        if (!/^(0x)?[0-9a-f]{64}$/.test(t)) throw new PayError('bad_tx', 'Paste the 64-character transaction ID.');
        t = chains[r.chain]?.nativeUnit === 'wei' ? '0x' + t.replace(/^0x/, '') : t.replace(/^0x/, '');
        let sentAmt = null;
        if (input.amount !== undefined && String(input.amount).trim() !== '') {
          if (!/^\d+(\.\d+)?$/.test(String(input.amount).trim())) throw new PayError('bad_amount', 'The amount sent should be a number, like 2.95.');
          sentAmt = toUnits(String(input.amount).trim(), r.decimals);
        }
        markRefundSent(id, t, sentAmt);
        return adminOrder(r.order_id);
      }
      default: throw new PayError('bad_action', 'Unknown action.');
    }
  }
  /** Ledger for taxes: one line per counted payment and per sent refund. */
  function ledger({ from = 0, to = now() + 1 } = {}) {
    const rows = all(`SELECT p.confirmed_at AS at, o.site, o.id AS order_id, o.ref, o.item, q.coin, p.amount, q.decimals, q.price_usd, p.tx, p.chain, o.test
      FROM payments p JOIN quotes q ON q.id = p.quote_id JOIN orders o ON o.id = p.order_id WHERE p.state = 'counted' AND p.confirmed_at BETWEEN ? AND ? ORDER BY p.confirmed_at`, from, to)
      .map((r) => ({ date: new Date(r.at * 1000).toISOString(), type: 'payment', site: r.site, order: r.order_id, ref: r.ref, item: r.item, coin: r.coin,
        amount: fromUnits(r.amount, r.decimals), usd: round2(Number(fromUnits(r.amount, r.decimals)) * r.price_usd), tx: r.tx, test: r.test ? 'yes' : '' }));
    const refunds = all(`SELECT r.*, o.site, o.ref, o.item, o.test, q.price_usd FROM refunds r JOIN orders o ON o.id = r.order_id LEFT JOIN quotes q ON q.id = o.paid_quote
      WHERE r.status = 'sent' AND r.sent_at BETWEEN ? AND ?`, from, to)
      .map((r) => ({ date: new Date(r.sent_at * 1000).toISOString(), type: 'refund', site: r.site, order: r.order_id, ref: r.ref, item: r.item, coin: r.coin,
        amount: '-' + fromUnits(r.sent_amount || r.amount, r.decimals), usd: r.price_usd ? -round2(Number(fromUnits(r.sent_amount || r.amount, r.decimals)) * r.price_usd) : '', tx: r.tx, test: r.test ? 'yes' : '' }));
    return [...rows, ...refunds].sort((a, b) => a.date.localeCompare(b.date));
  }
  function overview() {
    const since = now() - 30 * 86400;
    const wallets = Object.fromEntries(Object.keys(chains).map((c) => {
      const w = activeWallet(c);
      if (!w) return [c, null];
      const top = one('SELECT MAX(idx) AS m FROM addresses WHERE wallet_id = ?', w.id).m ?? 0;
      const lastUsed = one('SELECT MAX(idx) AS m FROM addresses WHERE wallet_id = ? AND used = 1', w.id).m ?? 0;
      return [c, { kind: w.kind, label: w.label, created: w.created, first_address: w.impl.address(w.kind === 'account' ? 0 : 0),
        addresses_out: one('SELECT COUNT(*) AS n FROM addresses WHERE wallet_id = ?', w.id).n, unused_gap: top - lastUsed, gap_budget: S().gap_budget }];
    }));
    return {
      counts: Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').map((r) => [r.status, r.n])),
      paid_30d_usd: round2(one("SELECT COALESCE(SUM(q.usd), 0) AS s FROM orders o JOIN quotes q ON q.id = o.paid_quote WHERE o.status = 'paid' AND o.paid_at > ? AND o.test = ?", since, S().network === 'testnet' ? 1 : 0).s),
      to_check: toCheck(), wallets, chains: Object.fromEntries(Object.entries(chains).map(([id, c]) => [id, { name: c.name, network: c.network, second_source: c.second_source, ...(health[id] || {}) }])),
      notices_failing: all('SELECT order_id, event, attempts, last_error FROM notices WHERE done = 0 AND attempts > 0 ORDER BY id DESC LIMIT 20'),
      recent_log: all('SELECT at, kind, detail FROM log ORDER BY id DESC LIMIT 30'),
    };
  }

  /** What the wallet Pay button should send now: the held quote (or the rest of it, if part paid). */
  function walletTarget(orderId) {
    const o = getOrder(orderId);
    if (!o) throw new PayError('not_found', 'This payment link does not exist.', 404);
    if (!OPEN.includes(o.status)) throw new PayError('closed', 'This order is no longer waiting for a payment.', 409);
    const q = quotesOf(o.id).at(-1);
    if (!q) throw new PayError('no_quote', 'Pick a coin first.');
    const t = totals(o)[q.id] || { confirmed: 0n, waiting: 0n };
    const got = t.confirmed + t.waiting;
    if (got === 0n && q.expires <= now()) throw new PayError('expired', 'The held price has run out. Get a fresh price first.', 409);
    const left = big(q.amount) - got;
    if (left <= 0n) throw new PayError('covered', 'This order is already paid or on its way.', 409);
    // a shared address is matched by exact amount: it must be the full amount, not a remainder
    if (q.shared && got > 0n) throw new PayError('shared_rest', 'Please send the rest with the QR code.', 409);
    return { chain: q.chain, address: q.address, unit: q.unit, amount: left.toString(), decimals: q.decimals, coin: q.coin };
  }

  return { prune, walletTarget, createOrder, publicView, siteView, quote, claim, requestRefund, sweep, evaluate, previewWallet, setWallet, activeWallet,
    adminOrders, adminOrder, adminAction, toCheck, ledger, overview, health, db };
}
