// Pawment server. One small process: no blockchain node, no keys that can spend.
//
//   Sites:  POST /api/orders                 (Authorization: Bearer <site API key>)  -> {id, checkout_url, …}
//           GET  /api/orders/<id>            (same key)                              -> order status
//   Buyers: GET  /o/<id>                     checkout + receipt page (the id is the private link)
//           GET  /api/pay/<id>   POST /api/pay/<id>/quote {coin}   /claim {tx}   /refund {address, note}
//   Owner:  /admin/api/…                     (Authorization: Bearer <admin key>)    used by the admin page (and any owner tool)
//
// Settings: PAY_SETTINGS (default ./settings.json). Secrets: PAY_DATA/secrets.json (made by `node cli.mjs init`).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { createEngine, PayError } from './core/engine.mjs';
import { load, save, validate } from './core/settings.mjs';
import { createPrices } from './core/prices.mjs';
import { createCardano } from './chains/cardano.mjs';
import { createCardanoSource } from './chains/cardano-source.mjs';
import { createWalletPay } from './chains/cardano-wallet.mjs';
import { createUtxoChain } from './chains/utxo.mjs';
import { createEvmChain, EVM } from './chains/evm.mjs';
import { createTronChain } from './chains/tron.mjs';
import { createMoneroChain } from './chains/monero.mjs';
import { sha256, safeEqual, ID_RE, hmac as hmacHex } from './core/util.mjs';

const ROOT = new URL('.', import.meta.url).pathname;

/**
 * One complete Pawment instance (settings, database, chains, HTTP routes).
 * server.mjs runs one; the demo host runs one small private sandbox per visitor.
 * @param {{data?: string, settingsPath?: string, sim?: boolean, demo?: object}} opt
 */
// fixed pretend prices for the demo (roughly real, Nov 2026; nothing is fetched)
const DEMO_PRICES = { ADA: 0.55, BTC: 90000, LTC: 85, BCH: 450, ETH: 3200, BNB: 600, POL: 0.4, TRX: 0.2, XMR: 160 };

export async function createApp(opt = {}) {
  const DATA = opt.data || process.env.PAY_DATA || join(ROOT, 'data');
  const SETTINGS_PATH = opt.settingsPath || process.env.PAY_SETTINGS || join(ROOT, 'settings.json');

  let settings = load(SETTINGS_PATH);
  const secrets = () => (existsSync(join(DATA, 'secrets.json')) ? JSON.parse(readFileSync(join(DATA, 'secrets.json'), 'utf8')) : { sites: {} });
  const readKeyFile = (p) => (p && existsSync(p) ? readFileSync(p, 'utf8').trim() : '');

  // Koios account token (optional): raises the daily limit. A wrong or expired token is refused (403),
  // so on 401/403 we stop sending it, fall back to the anonymous tier and email the owner once.
  let koiosBad = false, koiosWarned = false;
  const jwtExp = (t) => { try { return Number(JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()).exp) || 0; } catch { return 0; } };
  function koiosToken() {
    if (koiosBad) return '';
    const t = readKeyFile(secrets().koios_token_file);
    if (!t) return '';
    try {
      const exp = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp;
      const left = exp - Date.now() / 1000;
      if (left <= 0) return '';
      if (left < 14 * 86400 && !koiosWarned) { koiosWarned = true; sendAlert(settings.name + ': Koios token runs out soon', 'Your Koios token ends on ' + new Date(exp * 1000).toUTCString() + '. Renew it at koios.rest (Profile, same wallet account) and paste the new token in Settings (Koios box). Until then Cardano is read without it.').catch(() => {}); }
    } catch { /* not a readable token: send it anyway, Koios decides */ }
    return t;
  }
  const isKoios = (url) => /(^|\.)koios\.rest$/.test(new URL(url).host);
  function koiosRefused(status) {
    if (koiosBad) return;
    koiosBad = true;
    console.log('Koios refused our token (' + status + '): using the free anonymous tier');
    sendAlert(settings.name + ': Koios token not accepted', 'Koios answered ' + status + ' to our account token, so ' + settings.name + ' now reads Cardano without it (lower daily limit; Blockfrost still backs it up). Renew the token at koios.rest (Profile, same wallet account) and paste the new one in Settings (Koios box).').catch(() => {});
  }
  const DEMO = Boolean(opt.demo);   // public demo sandbox: pretend blockchain, no outside calls, no emails, secrets locked
  async function fetchJson(url, body, headers = {}) {
    if (DEMO) throw new Error('the demo does not contact outside services');
    const tok = isKoios(url) ? koiosToken() : '';
    if (tok) headers = { authorization: 'Bearer ' + tok, ...headers };
    const r = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', 'user-agent': 'Pawment/1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    if (tok && (r.status === 401 || r.status === 403)) { koiosRefused(r.status); return fetchJson(url, body, headers.authorization === 'Bearer ' + tok ? (({ authorization, ...h }) => h)(headers) : headers); }
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
    return r.json();
  }
  // the wallet Pay button's backup send goes to Koios too
  async function koiosPost(url, opts) {
    const tok = isKoios(url) ? koiosToken() : '';
    const r = await fetch(url, tok ? { ...opts, headers: { ...opts.headers, authorization: 'Bearer ' + tok } } : opts);
    if (tok && (r.status === 401 || r.status === 403)) { koiosRefused(r.status); return fetch(url, opts); }
    return r;
  }

  // one plug-in per chain that the coin list uses (adding a new chain to settings needs a restart)
  const UTXO = { btc: 'BTC', ltc: 'LTC', bch: 'BCH', grs: 'GRS' };
  const chains = {};
  const cardanoSource = createCardanoSource({ network: settings.network, fetchJson, blockfrostKey: () => readKeyFile(secrets().blockfrost_key_file) });
  for (const id of new Set(settings.coins.map((c) => c.chain))) {
    if (id === 'cardano') chains.cardano = createCardano({ network: settings.network, fetchJson, source: cardanoSource });
    else if (UTXO[id]) chains[id] = createUtxoChain(UTXO[id], { network: settings.network });
    else if (id === 'xmr') chains.xmr = createMoneroChain({ network: settings.network });
    else if (id === 'trx') chains.trx = createTronChain({ network: settings.network, tokens: () => settings.coins.filter((c) => c.chain === 'trx' && c.unit.startsWith('trc20:')).map((c) => ({ contract: c.unit.slice(6) })) });
    else if (EVM[id]) chains[id] = createEvmChain(id, { network: settings.network, tokens: () => settings.coins.filter((c) => c.chain === id && c.unit.startsWith('erc20:')).map((c) => ({ contract: c.unit.slice(6) })) });
    else console.log(`coin list mentions chain "${id}", which this version can't watch yet: its coins stay unavailable`);
  }
  // PAY_SIM=1 (test network only): a pretend blockchain for trying every screen without real coins.
  const SIM = (DEMO || (opt.sim ?? process.env.PAY_SIM === '1')) && settings.network === 'testnet';
  if (DEMO && settings.network !== 'testnet') throw new Error('the demo only runs on the test network');
  const sim = { tip: 1000, utxos: [], txs: {}, n: 0 };
  // the pretend chain: Cardano only for PAY_SIM, every chain in the demo
  for (const [id, chain] of Object.entries(chains)) {
    if (!SIM || (!DEMO && id !== 'cardano')) continue;
    Object.assign(chain, {
      tip: async () => sim.tip,
      incoming: async (addrs) => sim.utxos.filter((u) => u.chain === id && addrs.includes(u.address)),
      transaction: async (t) => sim.txs[t]?.filter((u) => u.chain === id) || null,
      confirm: async () => true,
    });
    delete chain.exportState; delete chain.importState;
    if (!DEMO) console.log('SIMULATED blockchain (PAY_SIM=1): no real payments are watched');
  }
  /** pretend payment to an address (demo + PAY_SIM): returns the pretend transaction id */
  function simPay(chainId, address, amounts) {
    const t = randomBytes(32).toString('hex');
    const row = { ref: t + '#0', tx: t, chain: chainId, address: String(address), block_height: sim.tip, amounts };
    sim.utxos.push(row); sim.txs[t] = [row];
    return t;
  }
  const walletPay = createWalletPay({ network: settings.network, fetchJson, post: koiosPost, source: cardanoSource });
  const prices = createPrices({ settings: () => settings, chains, fetchJson, now: () => Math.floor(Date.now() / 1000) });

  async function sendAlert(subject, text, keyOverride = '') {
    if (DEMO) return;
    const key = keyOverride || readKeyFile(secrets().resend_key_file);
    const { to, from } = settings.email_alerts || {};
    if (!key || !to || !from) { console.log('[alert, no email set up] ' + subject); return; }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }), signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('email service answered ' + r.status);
  }

  const db = new DatabaseSync(join(DATA, 'pay.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const engine = createEngine({ db, settings: () => settings, chains, prices, siteSecret: (site) => secrets().sites?.[site] || null, alert: sendAlert });

  // ------------------------------------------------------------------ helpers
  const SEC_HEADERS = {
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow',   // checkout links are private; the home page and legal pages opt back in
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SEC_HEADERS, ...extra });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  }
  async function readBody(req, max = 32768) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > max) throw new PayError('too_big', 'Request too large.', 413); chunks.push(c); }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PayError('bad_json', 'Request body must be JSON.'); }
  }
  const bearer = (req) => (String(req.headers.authorization || '').match(/^Bearer (\S{16,200})$/) || [])[1] || '';
  function siteFor(req) {
    const key = bearer(req);
    if (!key) return null;
    const h = sha256(key);
    for (const [id, s] of Object.entries(secrets().sites || {})) if (s.api_key_sha256 && safeEqual(s.api_key_sha256, h)) return id;
    return null;
  }
  function saveSecrets(next) {
    const f = join(DATA, 'secrets.json');
    writeFileSync(f + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(f + '.tmp', f);
  }
  // Dashboard sign-in: password -> session cookie (HttpOnly, SameSite=Strict, Secure behind https). Sessions live in memory:
  // a restart signs everyone out, which is fine for one owner.
  const sessions = new Map();   // token sha256 -> expires (ms)
  const cgPlatform = new Map(); // CoinGecko coin id -> {id: its Cardano token/policy id, at}
  const SESSION_MS = 12 * 3600 * 1000;
  const cookieToken = (req) => (String(req.headers.cookie || '').match(/(?:^|;\s*)pawment_admin=([A-Za-z0-9_-]{30,80})/) || [])[1] || '';
  function sessionOk(req) {
    const t = cookieToken(req);
    if (!t) return false;
    const exp = sessions.get(sha256(t));
    if (!exp || exp < Date.now()) { sessions.delete(sha256(t)); return false; }
    return true;
  }
  const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';
  function sameOrigin(req) {   // cookie-signed-in changes must come from this site's own pages
    const o = req.headers.origin;
    if (!o) return true;   // SameSite=Strict already keeps the cookie off other sites' requests
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    try { return new URL(o).host === host; } catch { return false; }
  }
  // "Coming soon" mode (settings.coming_soon): the public sees a teaser page; checkout pages, the dashboard and the buyer
  // API need a preview code first. Sites' order API (API key) and the admin API with the admin key still work.
  const GATE_DAYS = 30;
  function gateSecret() { const sec = secrets(); return sec.gate_cookie_secret || sec.admin_key_sha256 || ''; }
  function gateToken(exp) { const k = gateSecret(); if (!k) throw new PayError('not_set_up', 'Run node cli.mjs init first.', 503); return exp + '.' + hmacHex(k, 'gate:' + exp); }
  function gateOk(req) {
    if (!settings.coming_soon) return true;
    const t = (String(req.headers.cookie || '').match(/(?:^|;\s*)pay_preview=([0-9]+\.[0-9a-f]{64})/) || [])[1];
    if (!t) return false;
    const [exp] = t.split('.');
    return Boolean(gateSecret()) && Number(exp) > Date.now() / 1000 && safeEqual(gateToken(exp), t);   // no secret yet = never unlocked
  }
  function gateCodeOk(code) {
    const stored = secrets().gate_code;   // "scrypt:<salt hex>:<hash hex>"
    if (!stored || !code) return false;
    const [, salt, hash] = stored.split(':');
    return timingSafeEqual(scryptSync(String(code).trim().toLowerCase(), Buffer.from(salt, 'hex'), 32), Buffer.from(hash, 'hex'));
  }
  const isAdmin = (req) => {
    if (DEMO) return req.method === 'GET' || sameOrigin(req);   // the demo host only lets a visitor reach their own sandbox
    const k = bearer(req); const h = secrets().admin_key_sha256;
    if (k && h && safeEqual(sha256(k), h)) return true;
    return sessionOk(req) && (req.method === 'GET' || sameOrigin(req));
  };
  function passwordOk(pw) {
    if (DEMO) return true;   // demo: any password works (the page says so)
    const stored = secrets().admin_password;   // "scrypt:<salt hex>:<hash hex>"
    if (!stored || !pw) return false;
    const [, salt, hash] = stored.split(':');
    const got = scryptSync(String(pw), Buffer.from(salt, 'hex'), 32);
    return timingSafeEqual(got, Buffer.from(hash, 'hex'));
  }

  // small per-IP limits for the public buyer endpoints
  const hits = new Map();
  function limited(req, bucket, max, windowSec) {
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
    const key = bucket + '|' + ip, t = Date.now();
    const h = (hits.get(key) || []).filter((x) => t - x < windowSec * 1000);
    h.push(t); hits.set(key, h);
    return h.length > max;
  }
  const hitsTimer = setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 3600_000)) hits.delete(k); }, 600_000).unref();

  const TYPES = { '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  function staticFile(res, rel, extra = {}) {
    const file = normalize(join(ROOT, 'public', rel));
    if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not_found' });
    const type = TYPES[extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': rel.endsWith('.html') ? 'no-store' : rel.endsWith('.woff2') ? 'public, max-age=2592000' : 'public, max-age=300', ...SEC_HEADERS, ...extra });
    res.end(readFileSync(file));
  }
  const csv = (rows) => {
    if (!rows.length) return 'date,type,site,order,ref,item,coin,amount,usd,tx,test\n';
    const cols = Object.keys(rows[0]);
    const esc = (v) => { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `"'${s.replace(/"/g, '""')}"` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return cols.join(',') + '\n' + rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n') + '\n';
  };

  // ------------------------------------------------------------------ routes
  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = (re) => p.match(re);
    let g;

    // ---- coming-soon teaser and preview code
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      if (settings.coming_soon) return staticFile(res, 'soon/index.html');
      // an optional public home page (public/home/index.html); settings.analytics_origin may add one page-count script to it only
      if (existsSync(join(ROOT, 'public', 'home', 'index.html'))) {
        const a = settings.analytics_origin || '';
        return staticFile(res, 'home/index.html', { 'x-robots-tag': 'all', ...(a ? { 'content-security-policy': SEC_HEADERS['content-security-policy'].replace("script-src 'self'", "script-src 'self' " + a).replace("connect-src 'self'", "connect-src 'self' " + a) } : {}) });
      }
      return send(res, 302, '', 'text/plain', { location: settings.brand?.support_url || '/admin/' });
    }
    if (req.method === 'GET' && (g = m(/^\/soon\/([\w.-]+\.(?:css|js|png))$/))) return staticFile(res, 'soon/' + g[1]);
    if (p === '/api/preview' && req.method === 'GET') return send(res, 200, { coming_soon: Boolean(settings.coming_soon), unlocked: gateOk(req) });
    if (p === '/api/preview' && req.method === 'POST') {
      if (limited(req, 'preview', 10, 900)) return send(res, 429, { error: 'slow_down', message: 'Too many tries. Please wait 15 minutes.' });
      const body = await readBody(req);
      if (!gateCodeOk(body.code)) { await new Promise((r) => setTimeout(r, 500)); return send(res, 401, { error: 'code', message: "That code isn't right." }); }
      const exp = Math.floor(Date.now() / 1000) + GATE_DAYS * 86400;
      return send(res, 200, { ok: true }, undefined, { 'set-cookie': `pay_preview=${gateToken(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GATE_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}` });
    }
    // everything else needs the preview code while coming soon (the order API and the admin API use their own keys)
    const keyAuth = (p === '/api/orders' || p.startsWith('/api/orders/')) || (p.startsWith('/admin/api/') && bearer(req));
    if (settings.coming_soon && !gateOk(req) && !keyAuth && p !== '/api/health' && !p.startsWith('/assets/') && p !== '/privacy' && p !== '/terms') {
      if (req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/admin/api/')) return send(res, 302, '', 'text/plain', { location: '/' });
      return send(res, 403, { error: 'coming_soon', message: 'Not open yet.' });
    }
    if (req.method === 'GET' && (p === '/privacy' || p === '/terms')) return staticFile(res, 'legal' + p + '.html', { 'x-robots-tag': 'all' });
    if (req.method === 'GET' && (g = m(/^\/o\/([a-z0-9_]+)$/))) return ID_RE.test(g[1]) ? staticFile(res, 'checkout.html') : send(res, 404, { error: 'not_found' });
    // theme (settings.brand.theme, a file in public/themes/): same files for the checkout (/assets/…) and the dashboard (/admin/…)
    if (req.method === 'GET' && (g = m(/^\/(?:assets|admin)\/theme\.css$/))) {
      const t = settings.brand?.theme;
      if (!t) return send(res, 200, '/* no theme */', 'text/css; charset=utf-8');
      return staticFile(res, 'themes/' + t + '.css');
    }
    if (req.method === 'GET' && (g = m(/^\/(?:assets|admin)\/theme\.js$/))) return staticFile(res, 'themes/theme.js');
    if (req.method === 'GET' && (g = m(/^\/(?:assets|admin)\/fonts\/([\w.-]+\.(?:woff2|txt))$/))) return staticFile(res, 'themes/fonts/' + g[1]);
    if (req.method === 'GET' && (g = m(/^\/assets\/([\w.-]+)$/))) return staticFile(res, 'assets/' + g[1]);
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, chains: Object.fromEntries(Object.entries(engine.health).map(([k, v]) => [k, { ok: !v.error }])) });

    // buyers
    // wallet Pay button (CIP-30): build the exact payment, then put the wallet's signature on it and send it
    if (req.method === 'POST' && (g = m(/^\/api\/pay\/([a-z0-9_]+)\/wallet-(build|finish)$/))) {
      if (!ID_RE.test(g[1])) return send(res, 404, { error: 'not_found' });
      if (limited(req, 'wallet', 30, 600)) return send(res, 429, { error: 'slow_down', message: 'Too many tries. Please wait a few minutes.' });
      const body = await readBody(req, 600_000);
      try {
        if (g[2] === 'build') {
          const t = engine.walletTarget(g[1]);
          if (t.chain !== 'cardano') return send(res, 400, { error: 'chain', message: 'Use the QR code for this coin.' });
          return send(res, 200, await walletPay.build({ order: g[1], address: t.address, unit: t.unit, amount: t.amount, utxos: body.utxos, change: body.change }));
        }
        const done = walletPay.finish({ order: g[1], tx: body.tx, witness: body.witness });
        // send it ourselves too (some wallets don't), then look it up so the page shows "seen" as soon as it lands
        walletPay.submit(done.signed).catch((e) => console.log('wallet submit backup: ' + e.message));
        return send(res, 200, done);
      } catch (e) {
        if (e instanceof PayError) throw e;
        return send(res, 400, { error: e.code || 'wallet', message: e.message });
      }
    }
    if (DEMO && req.method === 'POST' && (g = m(/^\/api\/demo\/pay\/([a-z0-9_]+)$/))) {   // the checkout's "pretend to pay" buttons
      if (!ID_RE.test(g[1])) return send(res, 404, { error: 'not_found' });
      if (limited(req, 'demo-pay', 60, 600)) return send(res, 429, { error: 'slow_down', message: 'Too many pretend payments. Please wait a few minutes.' });
      const body = await readBody(req);
      const q = db.prepare('SELECT * FROM quotes WHERE order_id = ? ORDER BY created DESC, rowid DESC LIMIT 1').get(g[1]);
      if (!q) return send(res, 400, { error: 'no_quote', message: 'Pick a coin first.' });
      const want = BigInt(q.amount), pct = { exact: 100n, less: 60n, more: 130n }[body.how] ?? 100n;
      simPay(q.chain, q.address, { [q.unit]: want * pct / 100n });
      await engine.sweep();
      return send(res, 200, { ok: true });
    }
    if ((g = m(/^\/api\/pay\/([a-z0-9_]+)(?:\/(quote|claim|refund))?$/))) {
      if (!ID_RE.test(g[1])) return send(res, 404, { error: 'not_found', message: 'This payment link does not exist.' });
      if (req.method === 'GET' && !g[2]) {
        if (limited(req, 'view', 600, 600)) return send(res, 429, { error: 'slow_down', message: 'Too many requests. Please wait a minute.' });
        return send(res, 200, { ...engine.publicView(g[1]), demo: DEMO, wallet_pay: !DEMO && walletPay.available(), network_id: walletPay.networkId });
      }
      if (req.method !== 'POST' || !g[2]) return send(res, 405, { error: 'method' });
      const body = await readBody(req);
      if (g[2] === 'quote') {
        if (limited(req, 'quote', 40, 600)) return send(res, 429, { error: 'slow_down', message: 'Too many requests. Please wait a few minutes.' });
        return send(res, 200, engine.quote(g[1], String(body.coin || '')));
      }
      if (g[2] === 'claim') {
        if (limited(req, 'claim', 20, 600)) return send(res, 429, { error: 'slow_down', message: 'Too many tries. Please wait a few minutes.' });
        return send(res, 200, await engine.claim(g[1], body.tx));
      }
      if (g[2] === 'refund') {
        if (limited(req, 'refund', 6, 3600)) return send(res, 429, { error: 'slow_down', message: 'Too many tries. Please wait a while.' });
        return send(res, 200, engine.requestRefund(g[1], { address: body.address, note: body.note }));
      }
    }

    // sites
    if (p === '/api/orders' && req.method === 'POST') {
      const site = siteFor(req);
      if (!site) return send(res, 401, { error: 'unauthorized', message: 'Missing or wrong API key.' });
      return send(res, 201, engine.createOrder(site, await readBody(req)));
    }
    if ((g = m(/^\/api\/orders\/([a-z0-9_]+)$/)) && req.method === 'GET') {
      const site = siteFor(req);
      if (!site) return send(res, 401, { error: 'unauthorized', message: 'Missing or wrong API key.' });
      const v = engine.siteView(g[1]);
      if (v.site !== site) return send(res, 404, { error: 'not_found' });
      return send(res, 200, v);
    }

    // owner
    if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) return p === '/admin' ? send(res, 301, '', 'text/plain', { location: 'admin/' }) : staticFile(res, 'admin/index.html');
    if (req.method === 'GET' && (g = m(/^\/admin\/([\w.-]+\.(?:js|css|png))$/))) return staticFile(res, 'admin/' + g[1]);
    if (p === '/admin/api/login' && req.method === 'POST') {
      if (limited(req, 'login', 8, 900)) return send(res, 429, { error: 'slow_down', message: 'Too many tries. Wait 15 minutes.' });
      if (!sameOrigin(req)) return send(res, 403, { error: 'origin' });
      const body = await readBody(req);
      if (!passwordOk(body.password)) { await new Promise((r) => setTimeout(r, 600)); return send(res, 401, { error: 'password', message: 'That password is not right.' }); }
      const t = randomBytes(32).toString('base64url');
      sessions.set(sha256(t), Date.now() + SESSION_MS);
      return send(res, 200, { ok: true }, undefined, { 'set-cookie': `pawment_admin=${t}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}` });
    }
    if (p === '/admin/api/logout' && req.method === 'POST') {
      sessions.delete(sha256(cookieToken(req)));
      return send(res, 200, { ok: true }, undefined, { 'set-cookie': 'pawment_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0' });
    }
    if (p === '/admin/api/me' && req.method === 'GET') return send(res, 200, { signed_in: isAdmin(req), name: settings.name, has_password: Boolean(secrets().admin_password) });
    if (p.startsWith('/admin/api/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized', message: 'Please sign in again.' });
      const a = p.slice('/admin/api/'.length);
      if (req.method === 'GET') {
        if (a === 'overview') return send(res, 200, { demo: DEMO, ...engine.overview(), prices: prices.status(), settings, network: settings.network, blockfrost: Boolean(readKeyFile(secrets().blockfrost_key_file)), koios_token: Boolean(koiosToken()), koios_token_ends: jwtExp(readKeyFile(secrets().koios_token_file)) || null, koios_token_refused: koiosBad, email_key: Boolean(readKeyFile(secrets().resend_key_file)) });
        if (a === 'orders') return send(res, 200, engine.adminOrders({ filter: url.searchParams.get('filter') || 'all' }));
        if ((g = a.match(/^orders\/([a-z0-9_]+)$/))) return send(res, 200, engine.adminOrder(g[1]));
        if (a === 'check') return send(res, 200, engine.toCheck());
        if (a === 'ledger.csv') {
          const from = Date.parse(url.searchParams.get('from') || '1970-01-01') / 1000, to = Date.parse((url.searchParams.get('to') || '2999-01-01') + 'T23:59:59Z') / 1000;
          return send(res, 200, csv(engine.ledger({ from, to })), 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="payments-ledger.csv"` });
        }
        if (a === 'settings') return send(res, 200, settings);
        if (a.startsWith('tokens/search')) {   // find Cardano tokens: DexScreener + CoinGecko by name/ticker, or a policy id / full id
          const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
          if (q.length < 2) return send(res, 400, { error: 'short', message: 'Type at least 2 letters.' });
          const koios = settings.network === 'mainnet' ? 'https://api.koios.rest/api/v1' : 'https://preprod.koios.rest/api/v1';
          const underPolicy = async (policy, extra = {}) => {
            const assets = await fetchJson(koios + '/policy_asset_info', { _asset_policy: policy }).catch(() => []);
            return assets.slice(0, 10).map((x) => ({ unit: policy + (x.asset_name || ''), symbol: x.token_registry_metadata?.ticker || x.asset_name_ascii || '', name: x.token_registry_metadata?.name || x.asset_name_ascii || '', liquidity: null, ...extra }));
          };
          if (/^[0-9a-fA-F]{56}$/.test(q)) return send(res, 200, { results: await underPolicy(q.toLowerCase()), note: '' });
          if (/^[0-9a-fA-F]{57,120}$/.test(q)) return send(res, 200, { results: [{ unit: q.toLowerCase(), symbol: '', name: '', liquidity: null }], note: '' });
          const ql = q.toLowerCase().replace(/^\$/, '');
          const by = new Map();
          const d = await fetchJson('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(ql)).catch(() => ({ pairs: [] }));
          for (const p of d.pairs || []) {
            if (p.chainId !== 'cardano') continue;
            for (const t of [p.baseToken, p.quoteToken]) {
              const unit = String(t?.address || '').toLowerCase();
              if (!/^[0-9a-f]{56,120}$/.test(unit) || !(t.symbol + ' ' + t.name).toLowerCase().includes(ql)) continue;
              const e = by.get(unit) || { unit, symbol: t.symbol, name: t.name, liquidity: 0, source: 'DexScreener' };
              e.liquidity += Number(p.liquidity?.usd) || 0;
              by.set(unit, e);
            }
          }
          // CoinGecko: coins whose platform is Cardano (it often stores only the policy id). Its free tier is small: lookups are remembered for a day.
          let cgBusy = false;
          const cg = await fetchJson('https://api.coingecko.com/api/v3/search?query=' + encodeURIComponent(ql)).catch(() => { cgBusy = true; return { coins: [] }; });
          for (const coin of (cg.coins || []).filter((x) => x.market_cap_rank).slice(0, 4)) {
            let platform = cgPlatform.get(coin.id);
            if (platform === undefined || Date.now() - platform.at > 86400000) {
              const full = await fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin.id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`).catch(() => { cgBusy = true; return null; });
              if (!full) continue;
              platform = { id: String(full.platforms?.cardano || '').toLowerCase(), at: Date.now() };
              cgPlatform.set(coin.id, platform);
            }
            const id = platform.id;
            if (!/^[0-9a-f]{56,120}$/.test(id)) continue;
            const found = id.length === 56 ? await underPolicy(id, { source: 'CoinGecko' }) : [{ unit: id, symbol: coin.symbol, name: coin.name, liquidity: null, source: 'CoinGecko' }];
            for (const f of found) if (!by.has(f.unit)) by.set(f.unit, { ...f, symbol: f.symbol || coin.symbol, name: f.name || coin.name });
          }
          const results = [...by.values()].sort((x, y) => (y.liquidity || 0) - (x.liquidity || 0)).slice(0, 10);
          return send(res, 200, { results, note: !results.length && cgBusy ? 'CoinGecko is busy right now, so only DexScreener was searched. Try again in a minute, or paste the token\'s policy id.' : '' });
        }
        if (a === 'sites') { const sec = secrets().sites || {}; return send(res, 200, Object.fromEntries(Object.entries(settings.sites || {}).map(([id, v]) => [id, { ...v, has_keys: Boolean(sec[id]) }]))); }
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if ((g = a.match(/^action\/(\w+)\/([a-z0-9_|#]+)$/))) return send(res, 200, engine.adminAction(g[1], decodeURIComponent(g[2]), body));
        if (a === 'wallet/preview') return send(res, 200, engine.previewWallet(String(body.chain || ''), body.spec || {}));
        if (a === 'wallet/set') {
          if (!passwordOk(body.password)) return send(res, 403, { error: 'password', message: 'The password is not right.' });
          return send(res, 200, await engine.setWallet(String(body.chain || ''), body.spec || {}, { by: 'admin page' }));
        }
        if (a === 'settings') {
          try {
            const next = validate({ ...settings, ...body, sites: body.sites ?? settings.sites, network: settings.network, public_url: settings.public_url });
            settings = save(SETTINGS_PATH, next);
          } catch (e) { return send(res, 400, { error: 'bad_settings', message: e.message }); }
          prices.refresh().catch(() => {});
          return send(res, 200, settings);
        }
        if (SIM && a === 'sim/pay') {
          const amounts = Object.fromEntries(Object.entries(body.amounts || {}).map(([k, v]) => [k, BigInt(String(v))]));
          return send(res, 200, { tx: simPay(String(body.chain || 'cardano'), body.address, amounts) });
        }
        if (SIM && a === 'sim/blocks') { sim.tip += Number(body.n) || 1; await engine.sweep(); return send(res, 200, { tip: sim.tip }); }
        if (SIM && a === 'sim/sweep') { await engine.sweep({ wide: Boolean(body.wide) }); return send(res, 200, { ok: true }); }
        if (DEMO && ['blockfrost', 'koios', 'email-key', 'preview-code', 'test-email', 'password', 'tokens/check', 'tokens/add'].includes(a))
          return send(res, 403, { error: 'demo', message: 'Locked in the demo: on your own copy this works.' });
        if (a === 'blockfrost') {   // save (or remove) the Blockfrost project id: the second data source for Cardano
          const key = String(body.project_id || '').trim();
          const sec = secrets();
          if (!key) { delete sec.blockfrost_key_file; saveSecrets(sec); return send(res, 200, { ok: true, on: false, message: 'Blockfrost removed: Cardano is read from Koios only.' }); }
          const net = settings.network === 'mainnet' ? 'mainnet' : 'preprod';
          if (!new RegExp('^' + net + '[A-Za-z0-9]{20,64}$').test(key)) return send(res, 400, { error: 'key', message: 'A Blockfrost project id for this network starts with "' + net + '".' });
          try { await fetchJson(`https://cardano-${net}.blockfrost.io/api/v0/blocks/latest`, undefined, { project_id: key }); }
          catch (e) { return send(res, 400, { error: 'key', message: 'Blockfrost did not accept that project id (' + e.message + ').' }); }
          const f = join(DATA, 'blockfrost.key');
          writeFileSync(f, key + '\n', { mode: 0o600 });
          sec.blockfrost_key_file = f; saveSecrets(sec);
          return send(res, 200, { ok: true, on: true, message: 'Blockfrost is on: every Cardano payment is now checked a second time.' });
        }
        if (a === 'koios') {   // save (or remove) the Koios account token: raises Koios's daily limit
          const tok = String(body.token || '').trim(), sec = secrets();
          if (!tok) { delete sec.koios_token_file; saveSecrets(sec); koiosBad = false; koiosWarned = false; return send(res, 200, { ok: true, message: 'Koios token removed: Cardano is read with the free anonymous limit.' }); }
          if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tok)) return send(res, 400, { error: 'key', message: 'That does not look like a Koios token (a long code with two dots in it).' });
          const exp = jwtExp(tok);
          if (exp && exp < Date.now() / 1000) return send(res, 400, { error: 'key', message: 'That token has already run out. Make a new one at koios.rest (Profile).' });
          const host = settings.network === 'mainnet' ? 'https://api.koios.rest' : 'https://preprod.koios.rest';
          try {
            const r = await fetch(host + '/api/v1/tip', { headers: { accept: 'application/json', authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(20000) });
            if (!r.ok) return send(res, 400, { error: 'key', message: 'Koios did not accept that token (answered ' + r.status + ').' });
          } catch (e) { return send(res, 502, { error: 'koios', message: 'Could not reach Koios to test the token: ' + e.message }); }
          const f = join(DATA, 'koios.token');
          writeFileSync(f, tok + '\n', { mode: 0o600 });
          sec.koios_token_file = f; saveSecrets(sec);
          koiosBad = false; koiosWarned = false;
          sendAlert(settings.name + ': Koios token changed', 'A new Koios token was saved in the dashboard' + (exp ? ' (runs until ' + new Date(exp * 1000).toUTCString() + ')' : '') + '. If this was not you, sign in and change your password.').catch(() => {});
          return send(res, 200, { ok: true, message: 'Koios token saved and working' + (exp ? ', until ' + new Date(exp * 1000).toDateString() : '') + '.' });
        }
        if (a === 'email-key') {   // the Resend key alert emails are sent with: tested by sending a real test email
          if (!passwordOk(body.password)) return send(res, 403, { error: 'password', message: 'The password is not right.' });
          const key = String(body.key || '').trim();
          if (!/^re_[A-Za-z0-9_]{16,}$/.test(key)) return send(res, 400, { error: 'key', message: 'A Resend key starts with "re_".' });
          const { to, from } = settings.email_alerts || {};
          if (!to || !from) return send(res, 400, { error: 'no_email', message: 'Fill in "Send to" and "From" above and save them first.' });
          try { await sendAlert(settings.name + ': new email key works', 'Your ' + settings.name + ' dashboard just saved a new email-sending key. Alerts will arrive like this one. If this was not you, sign in and change your password.', key); }
          catch (e) { return send(res, 400, { error: 'key', message: 'Resend did not send with that key (' + e.message + '). Nothing was changed.' }); }
          const f = join(DATA, 'resend.key'), sec = secrets();
          writeFileSync(f, key + '\n', { mode: 0o600 });
          sec.resend_key_file = f; saveSecrets(sec);
          return send(res, 200, { ok: true, message: 'Saved. A test email went to ' + to + ' with the new key.' });
        }
        if (a === 'preview-code') {   // the coming-soon preview code; changing it signs every other device out of the preview
          if (!passwordOk(body.password)) return send(res, 403, { error: 'password', message: 'The password is not right.' });
          const code = String(body.code || '').trim().toLowerCase();
          if (code.length < 6) return send(res, 400, { error: 'short', message: 'Use at least 6 characters.' });
          const salt = randomBytes(16), sec = secrets();
          sec.gate_code = `scrypt:${salt.toString('hex')}:${scryptSync(code, salt, 32).toString('hex')}`;
          sec.gate_cookie_secret = randomBytes(32).toString('hex');
          saveSecrets(sec);
          sendAlert(settings.name + ': preview code changed', 'The coming-soon preview code was changed in the dashboard. Other devices need the new code. If this was not you, sign in and change your password.').catch(() => {});
          const exp = Math.floor(Date.now() / 1000) + GATE_DAYS * 86400;
          return send(res, 200, { ok: true, message: 'Preview code changed. Other devices will need the new code.' }, undefined, { 'set-cookie': `pay_preview=${gateToken(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GATE_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}` });
        }
        if (a === 'test-email') {   // the owner checks that alert emails arrive
          if (limited(req, 'test-email', 3, 3600)) return send(res, 429, { error: 'slow_down', message: 'Only a few test emails an hour, please.' });
          const { to, from } = settings.email_alerts || {};
          if (!to || !from) return send(res, 400, { error: 'no_email', message: 'Fill in "Send to" (and "From") in Settings first.' });
          try { await sendAlert(settings.name + ': test email', 'This is a test from your ' + settings.name + ' dashboard. Alerts (refund requests, payments that need you, wallet changes, a network watcher not working) arrive like this.'); }
          catch (e) { return send(res, 502, { error: 'email', message: 'The email service refused it: ' + e.message }); }
          return send(res, 200, { ok: true, message: 'Sent to ' + to + '. Check your inbox (and spam folder).' });
        }
        if (a === 'password') {
          if (!passwordOk(body.current)) return send(res, 403, { error: 'password', message: 'The current password is not right.' });
          if (String(body.next || '').length < 12) return send(res, 400, { error: 'short', message: 'Use at least 12 characters.' });
          const salt = randomBytes(16), sec = secrets();
          sec.admin_password = `scrypt:${salt.toString('hex')}:${scryptSync(String(body.next), salt, 32).toString('hex')}`;
          saveSecrets(sec);
          sessions.clear();
          return send(res, 200, { ok: true, message: 'Password changed. Please sign in again.' });
        }
        if ((g = a.match(/^sites\/([a-z0-9-]{2,30})\/(create|keys|remove)$/))) {
          const id = g[1], sec = secrets();
          sec.sites ||= {};
          if (g[2] === 'remove') {
            if (!passwordOk(body.password)) return send(res, 403, { error: 'password', message: 'The password is not right.' });
            delete sec.sites[id]; saveSecrets(sec);
            const { [id]: _gone, ...rest } = settings.sites || {};
            settings = save(SETTINGS_PATH, { ...settings, sites: rest });
            return send(res, 200, { ok: true });
          }
          if (g[2] === 'create' && (settings.sites?.[id] || sec.sites[id])) return send(res, 409, { error: 'exists', message: 'A site with that id already exists.' });
          if (g[2] === 'keys' && !sec.sites[id] && !settings.sites?.[id]) return send(res, 404, { error: 'not_found', message: 'No such site.' });
          const apiKey = 'pk_' + randomBytes(24).toString('base64url'), hook = 'whsec_' + randomBytes(24).toString('base64url');
          sec.sites[id] = { api_key_sha256: sha256(apiKey), webhook_secret: hook };
          saveSecrets(sec);
          if (g[2] === 'create') {
            const clean = (u) => (/^https?:\/\/\S{3,300}$/.test(String(u || '')) ? String(u) : '');
            settings = save(SETTINGS_PATH, { ...settings, sites: { ...(settings.sites || {}), [id]: { name: String(body.name || id).slice(0, 60), notify_url: clean(body.notify_url), return_url: clean(body.return_url) } } });
          }
          // shown once, to the signed-in owner, so they can paste them into their site
          return send(res, 200, { id, api_key: apiKey, webhook_secret: hook });
        }
        if (a === 'tokens/check' || a === 'tokens/add') {
          const unit = String(body.unit || '').trim().toLowerCase();
          if (!/^[0-9a-f]{56,120}$/.test(unit)) return send(res, 400, { error: 'unit', message: 'A Cardano token id is the policy id (56 characters) followed by the asset name in hex.' });
          if (settings.coins.some((c) => c.chain === 'cardano' && c.unit === unit)) return send(res, 409, { error: 'exists', message: 'That token is already in the coin list.' });
          const koios = settings.network === 'mainnet' ? 'https://api.koios.rest/api/v1' : 'https://preprod.koios.rest/api/v1';
          const [info] = await fetchJson(koios + '/asset_info', { _asset_list: [[unit.slice(0, 56), unit.slice(56)]] }).catch(() => []);
          if (!info) return send(res, 404, { error: 'not_found', message: 'That token does not exist on Cardano (check the policy id).' });
          const reg = info.token_registry_metadata || {};
          const cip = JSON.stringify(info.cip68_metadata || {});
          const cipDec = (cip.match(/"decimals"[^0-9]{0,40}(\d{1,2})/) || [])[1];
          const found = { unit, policy: unit.slice(0, 56), asset_name: info.asset_name_ascii || '', fingerprint: info.fingerprint, ticker: reg.ticker || '', name: reg.name || info.asset_name_ascii || '',
            decimals: Number.isInteger(reg.decimals) ? reg.decimals : cipDec !== undefined ? Number(cipDec) : 0, decimals_known: Number.isInteger(reg.decimals) || cipDec !== undefined,
            supply: info.total_supply, holders: null, url: reg.url || '' };
          if (a === 'tokens/check') {
            let price = null, price_error = null;
            try { price = await prices.tokenPrice({ id: 'check', chain: 'cardano', unit, decimals: found.decimals, kind: 'token', price: { token: true } }); } catch (e) { price_error = e.message; }
            return send(res, 200, { ...found, price, price_error });
          }
          const symbol = String(body.symbol || found.ticker || found.asset_name || 'TOKEN').replace(/^\$/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'TOKEN';
          let id = symbol, n = 2;
          while (settings.coins.some((c) => c.id.toLowerCase() === id.toLowerCase())) id = (symbol.slice(0, 9) + n++).slice(0, 12);
          const decimals = Number.isInteger(Number(body.decimals)) && Number(body.decimals) >= 0 && Number(body.decimals) <= 18 ? Number(body.decimals) : found.decimals;
          const coin = { id, chain: 'cardano', unit, decimals, name: String(body.name || found.name || symbol).slice(0, 40), symbol: '$' + symbol, kind: 'token', price: { token: true }, custom: true };
          settings = save(SETTINGS_PATH, { ...settings, coins: [...settings.coins, coin] });
          prices.refresh().catch(() => {});
          return send(res, 200, { added: coin });
        }
        if (a === 'tokens/remove') {
          const c = settings.coins.find((x) => x.id === String(body.id || ''));
          if (!c || !c.custom) return send(res, 400, { error: 'not_custom', message: 'Only tokens added from this page can be removed (built-in coins can be switched off instead).' });
          const sites = Object.fromEntries(Object.entries(settings.sites || {}).map(([k, sv]) => { const { [c.id]: _x, ...rest } = sv.coins || {}; return [k, { ...sv, coins: rest, ...(sv.featured === c.id ? { featured: '' } : {}) }]; }));
          settings = save(SETTINGS_PATH, { ...settings, coins: settings.coins.filter((x) => x.id !== c.id), featured: settings.featured === c.id ? '' : settings.featured, sites });
          return send(res, 200, { removed: c.id });
        }
        if (a === 'test-order') {   // the owner tries a checkout from the admin page
          const site = Object.keys(settings.sites || {})[0] || 'test';
          return send(res, 201, engine.createOrder(site, { amount: Number(body.amount) || 1, item: String(body.item || 'Test order'), ref: 'admin-test' }));
        }
      }
      return send(res, 404, { error: 'not_found' });
    }
    return send(res, 404, { error: 'not_found' });
  }

  async function handle(req, res) {
    try { await route(req, res); } catch (e) {
      if (e instanceof PayError) return send(res, e.status, { error: e.code, message: e.message });
      console.error(e);
      send(res, 500, { error: 'server', message: 'Something went wrong on our side. Please try again.' });
    }
  }
  let n = 0;
  /** one round of the background loop: prices now and then, then look at the chains */
  async function tick() {
    if (DEMO) { for (const c of settings.coins) prices.set(c.id, DEMO_PRICES[c.id] ?? (c.kind === 'stable' || /^USD|DJED|iUSD/.test(c.id) ? 1 : 0.5)); sim.tip++; }
    try { if (!DEMO && n % 15 === 0) await prices.refresh(); await engine.sweep({ wide: n % 30 === 0 }); } catch (e) { console.error('loop', e); }
    n++;
  }
  function close() { clearInterval(hitsTimer); try { db.close(); } catch { /* already closed */ } }
  return { handle, tick, close, simPay, engine, prices, db, settings: () => settings, sim: SIM ? sim : null };
}
