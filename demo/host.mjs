// Pawment live demo host . Every visitor gets a private sandbox: a full Pawment instance on a
// pretend blockchain with pretend prices, kept in a temporary folder and thrown away after an hour of no use.
// Nothing here talks to real blockchains, price services or email.
//
//   node demo/host.mjs        (DEMO_PORT, default 4202; DEMO_DIR, default <tmp>/pawment-demo)
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { createApp } from '../app.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '..');
const PORT = Number(process.env.DEMO_PORT || 4202);
const HOST = process.env.DEMO_HOST || '127.0.0.1';
const DIR = process.env.DEMO_DIR || join(tmpdir(), 'pawment-demo');
const PUBLIC_URL = process.env.DEMO_URL || 'http://127.0.0.1:' + PORT;
const MAX_SANDBOXES = Number(process.env.DEMO_MAX || 120);
const IDLE_MS = 60 * 60 * 1000;      // a sandbox lives for an hour after its last use
const NEW_PER_IP_HOUR = 8;
const TICK_MS = 3000;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const WALLETS = JSON.parse(readFileSync(join(HERE, 'wallets.json'), 'utf8'));

/** demo settings: the open-source example, on the test network, minus coins without a test network */
function demoSettings() {
  const base = JSON.parse(readFileSync(join(ROOT, 'settings.example.json'), 'utf8'));
  return {
    ...base,
    name: 'Pawment Demo Shop',
    public_url: PUBLIC_URL,
    network: 'testnet',
    coming_soon: false,
    coins: base.coins.filter((c) => c.chain !== 'grs'),
    sites: { shop: { name: 'Pawment Demo Shop', notify_url: '', return_url: '' } },
    email_alerts: { to: '', from: '' },
    brand: { ...(base.brand || {}), theme: '', logo: 'mark-64.png', support_url: '', terms_url: '', privacy_url: '' },
  };
}

const boxes = new Map();   // id -> { app, dir, last, created }
const made = new Map();    // ip -> [times]
let creating = 0;

async function newSandbox() {
  const id = randomBytes(18).toString('base64url');
  const dir = join(DIR, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(demoSettings(), null, 2));
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({
    admin_key_sha256: sha256(randomBytes(32).toString('hex')),
    sites: { shop: { api_key_sha256: sha256(randomBytes(24).toString('hex')), webhook_secret: 'whsec_' + randomBytes(24).toString('base64url') } },
  }), { mode: 0o600 });
  const app = await createApp({ data: dir, settingsPath, demo: true });
  await seed(app);
  const box = { app, dir, last: Date.now(), created: Date.now() };
  boxes.set(id, box);
  return id;
}

/** sample wallets, a few past orders and payments, so the dashboard isn't empty */
async function seed(app) {
  const { engine } = app;
  await app.tick();   // pretend prices
  for (const [chain, spec] of Object.entries(WALLETS)) {
    if (chain === 'note') continue;
    try { await engine.setWallet(chain, spec, { by: 'demo' }); } catch (e) { console.error('demo wallet', chain, e.message); }
  }
  await app.tick();   // fresh addresses get ready for the sample orders
  const order = (usd, item) => engine.createOrder('shop', { amount: usd, item, ref: 'demo-' + randomBytes(3).toString('hex') });
  const pay = async (o, coin, how) => {
    engine.quote(o.id, coin);
    const q = app.db.prepare('SELECT * FROM quotes WHERE order_id = ? ORDER BY created DESC, rowid DESC LIMIT 1').get(o.id);
    const pct = { exact: 100n, less: 60n, more: 130n }[how];
    app.simPay(q.chain, q.address, { [q.unit]: BigInt(q.amount) * pct / 100n });
  };
  await pay(order(24, 'Coffee beans, 1 kg'), 'ADA', 'exact');
  await pay(order(12.5, 'Mug'), 'USDCpol', 'exact');
  await pay(order(40, 'Hoodie'), 'BTC', 'less');
  await pay(order(8, 'Sticker pack'), 'LTC', 'more');
  order(15, 'T-shirt');   // still waiting
  for (let i = 0; i < 12; i++) await app.tick();   // blocks go by: the paid ones confirm
}

function dropSandbox(id) {
  const box = boxes.get(id);
  if (!box) return;
  boxes.delete(id);
  try { box.app.close(); } catch { /* gone */ }
  rmSync(box.dir, { recursive: true, force: true });
}

// background: confirm pretend payments in sandboxes in use, clear idle ones
setInterval(async () => {
  const t = Date.now();
  for (const [id, box] of boxes) {
    if (t - box.last > IDLE_MS) { dropSandbox(id); continue; }
    if (t - box.last < 15 * 60 * 1000) await box.app.tick();
  }
  for (const [ip, list] of made) { const keep = list.filter((x) => t - x < 3600_000); if (keep.length) made.set(ip, keep); else made.delete(ip); }
}, TICK_MS).unref();

// ---- the intro page and its files
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function page(res, rel) {
  const f = normalize(join(HERE, 'public', rel));
  if (!f.startsWith(join(HERE, 'public')) || !existsSync(f)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, { ...HEADERS, 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': rel.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
  res.end(readFileSync(f));
}
function message(res, status, title, text) {
  res.writeHead(status, { ...HEADERS, 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Pawment demo</title><link rel="stylesheet" href="/intro.css"></head>` +
    `<body><main class="wrap narrow"><h1>${title}</h1><p>${text}</p><p><a class="btn" href="/start">Start a fresh demo</a> <a class="btn-soft" href="/">About Pawment</a></p></main></body></html>`);
}

const cookieId = (req) => (String(req.headers.cookie || '').match(/(?:^|;\s*)pawment_demo=([A-Za-z0-9_-]{24})/) || [])[1] || '';
const ipOf = (req) => String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';

async function start(req, res) {
  const ip = ipOf(req), list = made.get(ip) || [];
  if (list.length >= NEW_PER_IP_HOUR) return message(res, 429, 'Lots of demos already', 'You have started several demos this hour. Please use the one you have, or try again a little later.');
  if (boxes.size + creating >= MAX_SANDBOXES) return message(res, 503, 'The demo is busy', 'Many people are trying the demo right now. Please try again in a few minutes.');
  const old = cookieId(req);
  if (old) dropSandbox(old);
  creating++;
  let id;
  try { id = await newSandbox(); } finally { creating--; }
  made.set(ip, [...list, Date.now()]);
  res.writeHead(302, { location: '/admin/', 'set-cookie': `pawment_demo=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200${isHttps(req) ? '; Secure' : ''}`, 'cache-control': 'no-store' });
  res.end();
}

// static files any sandbox would serve identically (dashboard and checkout code, styles, images)
const SHARED = /^\/(assets\/[\w.-]+|admin\/[\w.-]+\.(?:js|css|png)|themes\/[\w.-]+\.css)$/;
let shared = null;

const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return page(res, 'index.html');
    if (req.method === 'GET' && /^\/[\w-]+\.(css|png|svg|js|ico)$/.test(p) && p !== '/start') return page(res, p.slice(1));
    if (req.method === 'GET' && (p === '/assets/favicon.png' || p === '/admin/favicon.png')) return page(res, 'favicon.png');   // Pawment's own tab icon
    if (p === '/start') return start(req, res);
    if (p === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, sandboxes: boxes.size })); }
    const box = boxes.get(cookieId(req));
    if (box) { box.last = Date.now(); return box.app.handle(req, res); }
    if (req.method === 'GET' && SHARED.test(p)) return shared.handle(req, res);
    if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) return start(req, res);
    if (req.method === 'GET' && p.startsWith('/o/')) return message(res, 404, 'This demo checkout has gone', 'Demo checkouts live inside one visitor\'s sandbox, and sandboxes clear after an hour of no use.');
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'no_sandbox', message: 'Your demo has ended. Start a fresh one at /start.' }));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Something went wrong.'); }
  }
});

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true, mode: 0o700 });
shared = boxes.get(await newSandbox()).app;   // also proves a sandbox starts before we take visitors
boxes.clear();
server.listen(PORT, HOST, () => console.log(`Pawment demo on http://${HOST}:${PORT} (sandboxes in ${DIR})`));
