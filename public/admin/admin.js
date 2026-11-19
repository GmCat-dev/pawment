/* Pawment owner dashboard (standalone; other owner tools can use the same admin API).
   Sign in with the dashboard password. Everything here talks to ./api/… with the session cookie. */
(function () {
  'use strict';
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var app = $('#app');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 4000); }
  function when(t) { return t ? new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
  function usd(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function nice(v, decimals) { var s = String(v == null ? '' : v), neg = s.charAt(0) === '-'; if (neg) s = s.slice(1); var parts = s.split('.'), w = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','), f = parts[1] || ''; if (decimals === 8) { f = (f + '00000000').slice(0, 8); f = f.slice(0, 2) + ',' + f.slice(2, 5) + ',' + f.slice(5); } return (neg ? '-' : '') + w + (f ? '.' + f : ''); }
  function fmt(units, dec) { var s = String(units).replace('-', '').padStart(dec + 1, '0'); var w = dec ? s.slice(0, -dec) : s, f = dec ? s.slice(-dec).replace(/0+$/, '') : ''; return nice(w + (f ? '.' + f : ''), dec); }
  function api(method, p, body) {
    return fetch('api/' + p, { method: method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (r.status === 401 && p !== 'login') { showLogin(); throw new Error('Please sign in.'); } if (!r.ok) throw new Error(d.message || d.error || 'Request failed (' + r.status + ')'); return d; }); });
  }
  var STATUS = { open: 'Waiting', seen: 'Payment seen', part_paid: 'Part paid', paid: 'Paid', expired: 'Closed (nothing paid)', check: 'Needs you', cancelled: 'Cancelled' };
  var last = null, view = 'action', filter = 'all', timer = null;

  /* ---------- in-page dialog ---------- */
  function ask(o) {
    return new Promise(function (resolve) {
      var d = document.createElement('dialog'); d.className = 'dlg';
      d.innerHTML = '<h2>' + esc(o.title) + '</h2>' + (o.html || (o.text ? '<p class="muted">' + esc(o.text) + '</p>' : '')) +
        (o.input ? '<input class="in" type="' + (o.input === 'password' ? 'password' : 'text') + '" autocomplete="' + (o.input === 'password' ? 'current-password' : 'off') + '" placeholder="' + esc(o.placeholder || '') + '">' : '') +
        '<div class="acts">' + (o.cancel === false ? '' : '<button data-v="0">' + esc(o.cancel || 'Cancel') + '</button>') + '<button class="primary" data-v="1">' + esc(o.ok || 'OK') + '</button></div>';
      document.body.appendChild(d);
      function done(v) { var val = o.input ? $('.in', d).value : v; d.close(); d.remove(); resolve(v ? (o.input ? val : true) : false); }
      d.addEventListener('click', function (e) { var b = e.target.closest('button[data-v]'); if (b) done(b.dataset.v === '1'); else if (e.target === d) done(false); });
      d.addEventListener('cancel', function (e) { e.preventDefault(); done(false); });
      d.addEventListener('keydown', function (e) { if (e.key === 'Enter' && o.input) { e.preventDefault(); done(true); } });
      d.showModal(); (o.input ? $('.in', d) : $('button', d)).focus();
    });
  }
  function qr(text) {
    if (!window.qrcode) return '';
    var q = window.qrcode(0, 'M'); q.addData(text); q.make();
    var n = q.getModuleCount(), m = 4, p = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) p += 'M' + (c + m) + ',' + (r + m) + 'h1v1h-1z';
    return '<svg class="qr" viewBox="0 0 ' + (n + 2 * m) + ' ' + (n + 2 * m) + '"><rect width="100%" height="100%" fill="#fff"/><path d="' + p + '" fill="#111"/></svg>';
  }
  function explorer(p) { return /^https:\/\//.test(p.explorer || '') ? p.explorer : '#'; }
  function coinOf(unit) { return (last.settings.coins.find(function (c) { return c.unit === unit; }) || { id: unit === 'lovelace' ? 'ADA' : 'token', symbol: unit === 'lovelace' ? 'ADA' : 'token', decimals: unit === 'lovelace' ? 6 : 0 }); }

  /* ---------- sign in ---------- */
  function showLogin(msg) {
    clearInterval(timer); $('#signout').hidden = true;
    app.innerHTML = '<form class="card login" id="login"><h1>Sign in</h1><p class="muted">Payments dashboard</p>' + (msg ? '<p class="note bad">' + esc(msg) + '</p>' : '') +
      '<label class="muted" for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required><button class="primary" type="submit">Sign in</button></form>';
    $('#pw').focus();
  }
  app.addEventListener('submit', function (e) {
    if (e.target.id !== 'login') return; e.preventDefault();
    api('POST', 'login', { password: $('#pw').value }).then(function () { start(); }).catch(function (er) { showLogin(er.message); });
  });
  $('#signout').addEventListener('click', function () { api('POST', 'logout').then(function () { showLogin(); }); });

  /* ---------- sections ---------- */
  function tiles(d) {
    var c = d.counts || {}, pr = d.prices || {};
    var chs = Object.keys(d.chains).map(function (k) { return d.chains[k]; });
    var bad = chs.filter(function (x) { return x.error || !x.ok_at; }).map(function (x) { return x.name + (x.error ? '' : ' (starting)'); });
    var nW = Object.keys(d.wallets).length, setW = Object.keys(d.wallets).filter(function (k) { return d.wallets[k]; }).length;
    var stale = Object.keys(pr).filter(function (k) { var co = d.settings.coins.find(function (x) { return x.id === k; }); return co && co.enabled && !pr[k].fresh; });
    var need = d.to_check.orders.length + d.to_check.payments.length + d.to_check.refunds.length;
    var t = [['Paid, last 30 days', usd(d.paid_30d_usd)], ['Paid orders', c.paid || 0], ['Waiting', (c.open || 0) + (c.seen || 0) + (c.part_paid || 0)], ['Needs you', need],
      ['Blockchain watchers', bad.length ? 'Check: ' + bad.join(', ') : 'All ' + chs.length + ' OK'], ['Second check', chs.filter(function (x) { return x.second_source; }).length + ' of ' + chs.length + ' networks'],
      ['Prices', stale.length ? 'Missing: ' + stale.join(', ') : 'All fresh'], ['Receiving wallets', setW + ' of ' + nW + ' set']];
    document.title = (need ? '(' + need + ') ' : '') + d.settings.name + ' dashboard';
    return '<div class="tiles">' + t.map(function (x) { return '<div class="tile"><span class="muted small">' + esc(x[0]) + '</span><b>' + esc(x[1]) + '</b></div>'; }).join('') + '</div>';
  }

  function actionView(d) {
    var tc = d.to_check, h = '';
    var missing = Object.keys(d.wallets).filter(function (k) { return !d.wallets[k]; }).map(function (k) { return (HINT[k] || [k])[0]; });
    if (missing.length) h += '<div class="note warn">No receiving wallet yet for: ' + esc(missing.join(', ')) + '. Those coins can\'t be paid with until one is set (Wallet tab).</div>';
    if (!tc.orders.length && !tc.payments.length && !tc.refunds.length) return h + '<div class="card muted">Nothing needs you right now.</div>';
    tc.refunds.forEach(function (r) {
      h += '<div class="card" data-refund="' + esc(r.id) + '"><div class="row"><b>Refund ' + (r.status === 'approved' ? 'approved, waiting for you to send it' : 'asked for') + '</b><span class="muted small">' + when(r.created) + ' · order ' + esc(r.order_id) + '</span></div>' +
        '<p>' + esc(fmt(r.amount, r.decimals)) + ' ' + esc(r.symbol || r.coin) + ' (' + (r.kind === 'extra' ? 'the extra they sent' : r.kind === 'full' ? 'the full payment' : 'everything received') + ') to<br><code>' + esc(r.address) + '</code></p>' +
        (r.note ? '<p class="muted">“' + esc(r.note) + '”</p>' : '') + '<div class="row">' +
        (r.status === 'requested' ? '<button class="primary" data-ract="approve">Approve</button><button data-ract="decline">Decline</button>' : '') +
        '<button data-ract="send">How to send it</button><button data-ract="sent">I sent it: paste the transaction</button></div></div>';
    });
    tc.orders.forEach(function (o) {
      h += '<div class="card" data-order="' + esc(o.id) + '"><div class="row"><b>' + esc(o.item || 'Order') + ' · ' + usd(o.usd) + '</b><span class="muted small">' + esc(o.site) + ' · ' + when(o.created) + '</span></div><p>' + esc(o.check_reason || 'Needs a look.') + '</p>' +
        '<div class="row"><button class="primary" data-oact="accept">Count it as paid</button><button data-oact="reopen">Keep waiting</button><button data-oact="cancel">Cancel order</button><button data-open="' + esc(o.id) + '">Details</button></div></div>';
    });
    tc.payments.forEach(function (p) {
      h += '<div class="card" data-pay="' + esc(p.id) + '"><div class="row"><b>Payment to check: ' + esc(fmt(p.amount, p.decimals)) + ' ' + esc(p.symbol) + ' (' + esc(p.chain_name) + ')</b><span class="muted small">' + when(p.seen_at) + '</span></div>' +
        '<p>' + esc(p.reason || '') + (p.order_id ? ' · probably order ' + esc(p.order_id) : '') + '<br><a href="' + explorer(p) + '" target="_blank" rel="noopener noreferrer">View on the blockchain ↗</a></p>' +
        '<div class="row"><button data-pact="attach">Belongs to an order…</button><button data-pact="dismiss">Not an order payment</button></div></div>';
    });
    return h;
  }

  function ordersView(rows) {
    return '<div class="row">' + ['all', 'waiting', 'paid', 'action'].map(function (f) { return '<button class="' + (filter === f ? 'on' : '') + '" data-filter="' + f + '">' + { all: 'All', waiting: 'Waiting', paid: 'Paid', action: 'Needs you' }[f] + '</button>'; }).join('') + '</div>' +
      (rows.length ? '<div class="card scroll"><table><tr><th>When</th><th>Site</th><th>What</th><th>Price</th><th>Coin</th><th>Status</th></tr>' + rows.map(function (o) {
        return '<tr data-open="' + esc(o.id) + '"><td>' + when(o.created) + '</td><td>' + esc(o.site) + '</td><td>' + esc(o.item) + (o.ref ? '<br><small class="muted">' + esc(o.ref) + '</small>' : '') + '</td><td>' + usd(o.usd) + '</td><td>' +
          (o.coin ? esc(nice(o.coin_amount, o.decimals) + ' ' + o.coin) + (o.paid_usd != null && o.paid_usd !== o.usd ? '<br><small class="muted">' + usd(o.paid_usd) + ' after discount</small>' : '') : '') +
          '</td><td><span class="st ' + esc(o.status) + '">' + esc(STATUS[o.status] || o.status) + '</span>' + (o.test ? ' <small class="muted">test</small>' : '') + '</td></tr>';
      }).join('') + '</table></div>' : '<div class="card muted">No orders yet.</div>');
  }

  function coinsView(s) {
    return '<div class="card scroll"><h2>Coins and discounts</h2><p class="muted small">Buyers see the coins in this order (the featured coin always first). Use ↑ ↓ to move them, then Save. Discounts can have start and end dates. Changes apply to new checkouts straight away.</p>' +
      '<table><tr><th>Order</th><th>On</th><th>Coin</th><th>Featured</th><th>Discount %</th><th>Badge</th><th>From</th><th>Until</th><th>Min order $</th><th></th></tr>' + s.coins.map(function (c) {
        return '<tr data-coin="' + esc(c.id) + '"><td class="mv"><button type="button" class="tiny" data-move="up" aria-label="Move up">↑</button><button type="button" class="tiny" data-move="down" aria-label="Move down">↓</button></td><td><input type="checkbox" data-f="enabled"' + (c.enabled ? ' checked' : '') + '></td><td><b>' + esc(c.symbol || c.id) + '</b><br><small class="muted">' + esc(c.name || '') + '</small></td>' +
          '<td><input type="radio" name="feat" value="' + esc(c.id) + '"' + (s.featured === c.id ? ' checked' : '') + '></td><td><input class="num" type="number" min="0" max="90" data-f="discount" value="' + esc(c.discount || 0) + '"></td>' +
          '<td><input data-f="badge" maxlength="24" size="10" value="' + esc(c.badge || '') + '"></td><td><input type="date" data-f="from" value="' + esc(c.from || '') + '"></td><td><input type="date" data-f="until" value="' + esc(c.until || '') + '"></td>' +
          '<td><input class="num" type="number" min="0" data-f="min_usd" value="' + esc(c.min_usd || '') + '"></td><td>' + (c.custom ? '<button type="button" class="tiny danger" data-remove-token="' + esc(c.id) + '">Remove</button>' : '') + '</td></tr>';
      }).join('') + '<tr><td></td><td></td><td class="muted">No featured coin</td><td><input type="radio" name="feat" value=""' + (s.featured ? '' : ' checked') + '></td><td colspan="6"></td></tr></table>' +
      '<h3>Rules</h3><div class="grid">' + [['quote_minutes', 'Price held (minutes)'], ['grace_hours', 'Late payments still count (hours)'], ['tolerance_percent', 'Counts as paid within (%)'], ['refund_days', 'Refunds can be asked for (days)'], ['order_hours', 'Unstarted orders close after (hours)']]
        .map(function (f) { return '<label><span class="muted small">' + esc(f[1]) + '</span><input class="num" type="number" min="0" step="' + (f[0] === 'tolerance_percent' ? '0.1' : '1') + '" data-g="' + f[0] + '" value="' + esc(s[f[0]]) + '"></label>'; }).join('') +
      '</div><button class="primary" data-save="coins">Save coins and rules</button></div>' +
      '<div class="card"><h2>Add a Cardano token</h2><p class="muted small">Any Cardano native token ($GMGM, $SNEK, $VIPER…). Search by name or ticker, or paste its policy id. Copycat tokens often use the same name: check the policy id against the project\'s official one. Tokens you add are priced from DexScreener, CoinGecko and on-chain pools.</p>' +
      '<div class="row"><input id="tokq" placeholder="gmgm, snek, viper… or policy id" size="34"><button data-tok="search">Search</button></div><div id="tokres"></div></div>';
  }

  var HINT = {
    cardano: ['Cardano (ADA, tokens, stablecoins)', 'the <b>account public key</b> of a wallet account used only for payments (your wallet app shows it in that account\'s details; it starts with <code>xpub1</code> or <code>acct_xvk1</code>)', 'xpub1… / acct_xvk1… or addr1…'],
    btc: ['Bitcoin (BTC)', 'the wallet\'s <b>extended public key</b>: <code>zpub</code> (bc1… addresses; Trust Wallet, Sparrow, Electrum), or <code>ypub</code> / <code>xpub</code>', 'zpub… / ypub… / xpub… or bc1…'],
    ltc: ['Litecoin (LTC)', 'the wallet\'s <b>extended public key</b>: <code>zpub</code> (Trust Wallet), <code>Ltub</code> / <code>Mtub</code> (Electrum-LTC) or <code>xpub</code>', 'zpub… / Ltub… / Mtub… or ltc1…'],
    eth: ['Ethereum (ETH, USDT, USDC)', 'one ordinary <b>0x address</b> (MetaMask, Trust Wallet, Coinomi…); the same address can be used on Ethereum, BNB Smart Chain and Polygon', '0x…'],
    bsc: ['BNB Smart Chain (BNB, USDT, USDC)', 'one ordinary <b>0x address</b>; the same one as for Ethereum works', '0x…'],
    polygon: ['Polygon (POL, USDT, USDC)', 'one ordinary <b>0x address</b>; the same one as for Ethereum works', '0x…'],
    trx: ['TRON (TRX, USDT)', 'one ordinary <b>TRON address</b> (starts with T; TronLink, Trust Wallet…)', 'T…'],
    xmr: ['Monero (XMR)', 'your wallet\'s <b>primary address</b> (starts with 4) and its <b>private VIEW key</b> (64 characters), on two lines. The view key only lets this server see incoming payments; never paste the spend key or the seed', 'primary address (4…)\nprivate view key (64 letters and numbers)'],
    grs: ['Groestlcoin (GRS)', 'the wallet\'s <b>extended public key</b>: <code>zpub</code>, <code>ypub</code> or <code>xpub</code> from Electrum-GRS', 'zpub… / ypub… / xpub… or grs1…'],
    bch: ['Bitcoin Cash (BCH)', 'the wallet\'s <b>extended public key</b> (<code>xpub</code>, e.g. from Electron Cash)', 'xpub… or bitcoincash:q…'],
  };
  function specFrom(raw) {
    var parts = raw.split(/\s+/), key = parts.find(function (x) { return /^[0-9a-fA-F]{64}$/.test(x); }), adr = parts.find(function (x) { return /^[48][0-9A-Za-z]{90,110}$/.test(x); });
    if (key && adr) return { address: adr, view_key: key };
    return /^(xpub|ypub|zpub|Ltub|Mtub|tpub|upub|vpub|acct_xvk)/.test(raw) ? { account_key: raw } : { address: raw };
  }
  function walletView(d) {
    return Object.keys(d.wallets).map(function (chain) {
      var w = d.wallets[chain], hn = HINT[chain] || [chain, 'an extended public key', ''];
      return '<div class="card" data-chain="' + esc(chain) + '"><h2>Receiving wallet: ' + esc(hn[0]) + '</h2>' +
        (w ? '<p>' + esc(w.label) + ' · set ' + when(w.created) + '</p><p class="muted">Main address: <code>' + esc(w.first_address) + '</code></p>' +
          (w.kind === 'account' ? '<p class="muted small">Fresh addresses handed out: ' + esc(w.addresses_out) + ' · unused in a row: ' + esc(w.unused_gap) + ' of ' + esc(w.gap_budget) + ' allowed (wallet apps stop looking after 20)</p>' : '')
          : '<p class="note warn">Not set yet: these coins can\'t be paid with until it is.</p>') +
        '<details' + (w ? '' : ' open') + '><summary>' + (w ? 'Change it' : 'Set it') + '</summary><p class="muted small">Best: ' + hn[1] + ', from a wallet or account used only for payments. Every order then gets its own address. ' +
        'Or one plain address (orders are then told apart by exact amounts). Never paste a recovery phrase or private key: they are refused.</p>' +
        '<textarea class="wal" spellcheck="false" placeholder="' + esc(hn[2]) + '"></textarea><div class="row"><button data-wallet="preview">Check it</button></div><div class="walOut"></div></details></div>';
    }).join('');
  }

  function sitesView(sites) {
    var ids = Object.keys(sites);
    return '<div class="card"><h2>Sites</h2><p class="muted small">Each website that takes payments gets its own API key (to create orders) and webhook secret (to check the signed "paid" messages). Keys are shown once.</p>' +
      (ids.length ? '<div class="scroll"><table><tr><th>Id</th><th>Name</th><th>Paid message goes to</th><th>Back link</th><th></th></tr>' + ids.map(function (id) {
        var s = sites[id];
        return '<tr data-site="' + esc(id) + '"><td><code>' + esc(id) + '</code></td><td>' + esc(s.name || '') + '</td><td class="small">' + esc(s.notify_url || '(none: per order)') + '</td><td class="small">' + esc(s.return_url || '') + '</td>' +
          '<td><button data-site-act="keys">' + (s.has_keys ? 'New keys' : 'Make keys') + '</button> <button class="danger" data-site-act="remove">Remove</button></td></tr>';
      }).join('') + '</table></div>' : '<p class="muted">No sites yet.</p>') +
      '<h3>Add a site</h3><div class="grid"><label><span class="muted small">Id (lowercase, e.g. tinyada)</span><input id="sid" maxlength="30"></label><label><span class="muted small">Name shown to buyers</span><input id="sname" maxlength="60"></label>' +
      '<label><span class="muted small">"Paid" messages go to (https://…)</span><input id="snotify"></label><label><span class="muted small">"Back to site" link (optional)</span><input id="sreturn"></label></div><button class="primary" data-site-add="1">Add site</button></div>' +
      '<div class="card"><h2>For developers</h2><pre class="mono small">POST /api/orders   Authorization: Bearer &lt;API key&gt;\n{ "amount": "5.00", "currency": "USD", "item": "Plus, 1 month", "ref": "user-123",\n  "notify_url": "https://your-site/paid", "return_url": "https://your-site/thanks" }\n→ { "id": "ord_…", "checkout_url": "…/o/ord_…" }\n\n' +
      'Paid message: POST notify_url with header\nPawment-Signature: t=&lt;unix time&gt;,v1=&lt;hex HMAC-SHA256(webhook secret, "&lt;t&gt;.&lt;body&gt;")&gt;</pre></div>';
  }

  function ledgerView() {
    var y = new Date().getFullYear();
    return '<div class="card"><h2>Ledger for taxes</h2><p class="muted small">One line per payment and per refund, with the dollar value at the time.</p><div class="row"><label>From <input type="date" id="lf" value="' + y + '-01-01"></label><label>To <input type="date" id="lt" value="' + y + '-12-31"></label><a class="btn" id="ldl" href="#">Download CSV</a></div></div>';
  }

  function settingsView(s) {
    var b = s.brand || {}, e = s.email_alerts || {};
    return '<div class="card"><h2>General</h2><div class="grid"><label><span class="muted small">Name shown on checkout</span><input id="gname" value="' + esc(s.name) + '"></label>' +
      '<label><span class="muted small">Accent colour</span><input id="gacc" type="color" value="' + esc(b.accent || '#6b4fd8') + '"></label>' +
      '<label><span class="muted small">Help link</span><input id="gsup" value="' + esc(b.support_url || '') + '"></label><label><span class="muted small">Terms link</span><input id="gterms" value="' + esc(b.terms_url || '') + '"></label>' +
      '<label><span class="muted small">Privacy link</span><input id="gpriv" value="' + esc(b.privacy_url || '') + '"></label></div>' +
      '<h3>Urgent email alerts</h3><p class="muted small">Sent when a receiving wallet changes.</p><div class="grid"><label><span class="muted small">Send to</span><input id="eto" type="email" value="' + esc(e.to || '') + '"></label><label><span class="muted small">From (a verified sender)</span><input id="efrom" value="' + esc(e.from || '') + '"></label></div>' +
      '<div class="row"><button class="primary" data-save="general">Save</button><button data-test-email="1">Send a test email</button></div><p class="muted small">Alerts go out for: refund requests, payments that need you, receiving-wallet changes, and a network watcher not working for 30 minutes.</p></div>' +
      '<div class="card"><h2>Coming soon</h2><label class="row"><input type="checkbox" id="gsoon"' + (s.coming_soon ? ' checked' : '') + '> <span>Show the "coming soon" page to the public; checkout and this dashboard need the preview code.</span></label><p class="muted small">Untick when you are ready to open. Sites can still create test orders with their API key either way.</p><button data-save="soon">Save</button></div>' +
      '<div class="card"><h2>Blockfrost (second check for Cardano)</h2><p>' + (last.blockfrost ? '<b>On.</b> Every Cardano payment is checked on Blockfrost as well as Koios.' : '<b>Off.</b> Cardano payments are read from Koios only.') + '</p>' +
      '<p class="muted small">Make a free account at blockfrost.io, create a project for Cardano ' + (s.network === 'mainnet' ? 'mainnet' : 'preprod') + ', and paste its project id here. It is tested with Blockfrost before it is saved, and never shown again.</p>' +
      '<div class="row"><input id="bfkey" type="password" autocomplete="off" placeholder="' + (s.network === 'mainnet' ? 'mainnet…' : 'preprod…') + '" size="40"><button class="primary" data-save="blockfrost">Save</button>' + (last.blockfrost ? '<button class="danger" data-save="blockfrost-off">Remove</button>' : '') + '</div></div>' +
      '<div class="card"><h2>Koios (Cardano data, account token)</h2><p>' + (last.koios_token_refused ? '<b class="bad">Refused.</b> Koios no longer accepts the saved token, so Cardano is read with the free anonymous limit. Paste a new one.' : last.koios_token ? '<b>On.</b> Higher daily limit' + (last.koios_token_ends ? ', until ' + esc(new Date(last.koios_token_ends * 1000).toDateString()) : '') + '.' : '<b>Off.</b> Cardano is read with Koios\'s free anonymous limit (5,000 requests a day).') + '</p>' +
      '<p class="muted small">Optional. At koios.rest open Profile, connect a Cardano wallet, pick the Free tier and paste the token here (50,000 requests a day). It is tested with Koios before it is saved, and never shown again. Renew with the same wallet account.</p>' +
      '<div class="row"><input id="kotok" type="password" autocomplete="off" placeholder="eyJ…" size="40"><button class="primary" data-save="koios">Save</button>' + (last.koios_token ? '<button class="danger" data-save="koios-off">Remove</button>' : '') + '</div></div>' +
      '<div class="card"><h2>Email-sending key (Resend)</h2><p>' + (last.email_key ? '<b>Set.</b> Alert emails can go out.' : '<b>Not set.</b> Alerts are only written to the log.') + '</p>' +
      '<p class="muted small">From resend.com (API keys; "sending access" is enough). Saving sends a real test email with the new key first; nothing changes if it fails. Never shown again.</p>' +
      '<div class="grid"><label><span class="muted small">New key</span><input id="rskey" type="password" autocomplete="off" placeholder="re_…"></label><label><span class="muted small">Your dashboard password</span><input id="rspw" type="password" autocomplete="current-password"></label></div><button class="primary" data-save="email-key">Test and save</button></div>' +
      '<div class="card"><h2>Preview code</h2><p class="muted small">The code that gets past the coming-soon page. Changing it asks every other device for the new code; this one stays in.</p>' +
      '<div class="grid"><label><span class="muted small">New code (6+ characters)</span><input id="pvcode" type="password" autocomplete="off"></label><label><span class="muted small">Your dashboard password</span><input id="pvpw" type="password" autocomplete="current-password"></label></div><button data-save="preview-code">Change code</button></div>' +
      '<div class="card"><h2>Password</h2><div class="grid"><label><span class="muted small">Current password</span><input id="pc" type="password" autocomplete="current-password"></label><label><span class="muted small">New password (12+ characters)</span><input id="pn" type="password" autocomplete="new-password"></label></div><button data-save="password">Change password</button></div>' +
      '<p class="muted small">Network: ' + esc(s.network) + ' · Checkout address: ' + esc(s.public_url) + '/o/…</p>';
  }

  function render(d, orders, sites) {
    var tabs = [['action', 'Needs you'], ['orders', 'Orders'], ['coins', 'Coins & discounts'], ['wallet', 'Wallet'], ['sites', 'Sites'], ['ledger', 'Ledger'], ['settings', 'Settings']];
    $('#brand').innerHTML = esc(d.settings.name) + '<span class="dash"> · dashboard</span>';
    if (d.demo && !document.getElementById('demo-bar')) { var bar = document.createElement('div'); bar.id = 'demo-bar'; bar.className = 'demo-bar'; bar.innerHTML = '<strong>Live demo</strong> with pretend money on test networks. This sandbox is only yours and clears after an hour of no use. Any password works. <a href="/">About Pawment</a>'; document.body.insertBefore(bar, document.body.firstChild); }
    var lg = (d.settings.brand || {}).logo, li = $('#logo');
    if (lg && li.hidden) { li.src = /^https?:/.test(lg) ? lg : (d.settings.public_url.replace(/\/$/, '') + '/' + lg.replace(/^\//, '')); li.hidden = false; }
    var n = $('#net'); n.hidden = false; n.textContent = d.network === 'testnet' ? 'Test network' : 'Live (mainnet)'; n.className = 'net' + (d.network === 'testnet' ? '' : ' main');
    if (!(d.settings.brand || {}).theme && /^#[0-9a-f]{6}$/i.test((d.settings.brand || {}).accent || '')) document.documentElement.style.setProperty('--accent', d.settings.brand.accent);
    app.innerHTML = tiles(d) + '<div class="tabs">' + tabs.map(function (t) { return '<button class="' + (view === t[0] ? 'on' : '') + '" data-view="' + t[0] + '">' + t[1] + '</button>'; }).join('') +
      '<button data-test="1">Try a $1 checkout ↗</button></div>' +
      ({ action: actionView, orders: function () { return ordersView(orders); }, coins: function () { return coinsView(d.settings); }, wallet: walletView, sites: function () { return sitesView(sites); }, ledger: ledgerView, settings: function () { return settingsView(d.settings); } }[view])(d);
  }
  function load() {
    return Promise.all([api('GET', 'overview'), view === 'orders' ? api('GET', 'orders?filter=' + filter) : [], view === 'sites' ? api('GET', 'sites') : {}])
      .then(function (r) { last = r[0]; render(r[0], r[1], r[2]); });
  }
  function start() {
    $('#signout').hidden = false;
    load().catch(function (e) { if (!/sign in/i.test(e.message)) app.innerHTML = '<div class="card note bad">' + esc(e.message) + '</div>'; });
    clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden && !$('dialog[open]') && (view === 'action' || view === 'orders')) load().catch(function () {}); }, 30000);
  }
  function act(p, body, msg) { return api('POST', p, body || {}).then(function (r) { if (msg) toast(msg); return load().then(function () { return r; }); }); }
  function fail(e) { toast(e.message); }

  /* ---------- clicks ---------- */
  app.addEventListener('click', function (e) {
    var b = e.target.closest('button, tr[data-open], a#ldl'); if (!b) return;
    if (b.id === 'ldl') { e.preventDefault(); location.href = 'api/ledger.csv?from=' + encodeURIComponent($('#lf').value) + '&to=' + encodeURIComponent($('#lt').value); return; }
    if (b.dataset.view) { view = b.dataset.view; return load().catch(fail); }
    if (b.dataset.filter) { filter = b.dataset.filter; return load().catch(fail); }
    if (b.dataset.open) return openOrder(b.dataset.open);
    if (b.dataset.test) return api('POST', 'test-order', { amount: 1, item: 'Test checkout' }).then(function (o) { window.open(o.checkout_url, '_blank', 'noopener'); }).catch(fail);
    var card = b.closest('[data-order],[data-pay],[data-refund]');
    if (b.dataset.oact) {
      var m = { accept: ['Count it as paid?', 'The site is told it is paid and unlocks what was bought.', 'Count as paid'], reopen: ['Keep waiting?', 'The order goes back to waiting.', 'Keep waiting'], cancel: ['Cancel this order?', 'The buyer\'s page says it was cancelled. Money that already arrived stays listed for a refund.', 'Cancel order'] }[b.dataset.oact];
      return ask({ title: m[0], text: m[1], ok: m[2] }).then(function (y) { if (y) return act('action/' + b.dataset.oact + '/' + card.dataset.order, {}, 'Done.'); }).catch(fail);
    }
    if (b.dataset.pact === 'dismiss') return ask({ title: 'Not an order payment?', text: 'It moves out of this list (it stays in the history).', ok: 'Yes' }).then(function (y) { if (y) return act('action/dismiss/' + encodeURIComponent(card.dataset.pay)); }).catch(fail);
    if (b.dataset.pact === 'attach') return ask({ title: 'Which order is it for?', text: 'Paste the order id (starts with ord_).', input: 'text', placeholder: 'ord_…', ok: 'Attach' }).then(function (v) { if (v) return act('action/attach/' + encodeURIComponent(card.dataset.pay), { order_id: v.trim() }, 'Attached.'); }).catch(fail);
    if (b.dataset.ract) {
      var rid = card.dataset.refund, r = last.to_check.refunds.find(function (x) { return x.id === rid; });
      if (b.dataset.ract === 'approve') return ask({ title: 'Approve this refund?', text: 'Then send it from your wallet. It is noticed automatically when it arrives, and the buyer sees it.', ok: 'Approve' }).then(function (y) { if (y) return act('action/refund_approve/' + rid); }).catch(fail);
      if (b.dataset.ract === 'decline') return ask({ title: 'Decline this refund?', text: 'Optional: a short reason.', input: 'text', ok: 'Decline' }).then(function (v) { if (v !== false) return act('action/refund_decline/' + rid, { note: v || '' }); }).catch(fail);
      if (b.dataset.ract === 'send') { var amt = fmt(r.amount, r.decimals), uri = r.uri || r.address; return ask({ title: 'Send ' + amt + ' ' + (r.symbol || r.coin) + ' (' + (r.chain_name || '') + ')', html: '<div class="center">' + qr(uri) + '</div><p>To <code>' + esc(r.address) + '</code></p><p class="muted">Check it ends in <b>' + esc(r.address.slice(-6)) + '</b> in your wallet before sending. The network fee comes out of the refund: send this amount minus your wallet\'s fee.</p>', ok: 'Close', cancel: false }); }
      if (b.dataset.ract === 'sent') return ask({ title: 'Refund sent?', text: 'Paste the transaction ID from your wallet.', input: 'text', ok: 'Next' }).then(function (v) {
        if (!v) return;
        return ask({ title: 'How much was sent?', text: 'The amount that left your wallet for the buyer, after the network fee (leave empty if it was exactly ' + fmt(r.amount, r.decimals) + ' ' + (r.symbol || r.coin) + ').', input: 'text', placeholder: 'e.g. 2.95', ok: 'Mark as refunded' })
          .then(function (amt) { if (amt !== false) return act('action/refund_sent/' + rid, { tx: v.trim(), amount: String(amt || '').replace(/,/g, '').trim() }, 'Marked as refunded.'); });
      }).catch(fail);
    }
    if (b.dataset.move) {
      var tr = b.closest('tr'), sib = b.dataset.move === 'up' ? tr.previousElementSibling : tr.nextElementSibling;
      if (sib && sib.dataset.coin) { if (b.dataset.move === 'up') tr.parentNode.insertBefore(tr, sib); else tr.parentNode.insertBefore(sib, tr); }
      $('[data-save="coins"]', app).textContent = 'Save coins and rules (order changed)';
      return;
    }
    if (b.dataset.removeToken) return ask({ title: 'Remove ' + b.dataset.removeToken + '?', text: 'Buyers can no longer pick it. Orders already paid with it stay in the history.', ok: 'Remove' })
      .then(function (y) { if (y) return act('tokens/remove', { id: b.dataset.removeToken }, 'Removed.'); }).catch(fail);
    if (b.dataset.tok === 'search') {
      var out = $('#tokres'); out.innerHTML = '<p class="muted small">Searching…</p>';
      return api('GET', 'tokens/search?q=' + encodeURIComponent($('#tokq').value.trim())).then(function (r) {
        var list = r.results || [];
        out.innerHTML = list.length ? '<table><tr><th>Token</th><th>Policy id</th><th>Liquidity</th><th></th></tr>' + list.map(function (t) {
          return '<tr><td><b>' + esc(t.symbol || '?') + '</b><br><small class="muted">' + esc(t.name || '') + '</small></td><td class="mono small">' + esc(t.unit.slice(0, 56)) + '</td><td>' + (t.liquidity === null ? '' : usd(t.liquidity)) + '</td><td><button data-tok="check" data-unit="' + esc(t.unit) + '">Check</button></td></tr>';
        }).join('') + '</table>' : '<p class="muted small">' + esc(r.note || 'Nothing found on Cardano with that name. Try the ticker, or paste the policy id.') + '</p>';
      }).catch(function (er) { out.innerHTML = '<p class="note bad">' + esc(er.message) + '</p>'; });
    }
    if (b.dataset.tok === 'check') {
      var res = $('#tokres'); res.innerHTML = '<p class="muted small">Checking on the blockchain…</p>';
      return api('POST', 'tokens/check', { unit: b.dataset.unit }).then(function (t) {
        var pr = t.price ? '$' + (t.price.usd < 0.01 ? t.price.usd.toPrecision(3) : t.price.usd.toFixed(4)) + ' <small class="muted">(' + esc(Object.keys(t.price.sources).join(', ')) + ')</small>' + (t.price.warning ? '<br><small class="muted">Note: ' + esc(t.price.warning) + '. Prices of small tokens move a lot; buyers always pay the price held for 30 minutes.</small>' : '') : '<span class="note bad">' + esc(t.price_error || 'no price') + '</span>';
        res.innerHTML = '<div class="card"><h3>' + esc(t.ticker || t.asset_name || 'Token') + '</h3><p class="mono small">Policy id: ' + esc(t.policy) + '<br>Asset name: ' + esc(t.asset_name) + ' · ' + esc(t.fingerprint || '') + '</p>' +
          '<p>Price now: ' + pr + '</p><div class="grid"><label><span class="muted small">Ticker shown to buyers</span><input id="toksym" maxlength="10" value="' + esc(t.ticker || t.asset_name) + '"></label>' +
          '<label><span class="muted small">Name</span><input id="tokname" maxlength="40" value="' + esc(t.name) + '"></label>' +
          '<label><span class="muted small">Decimals' + (t.decimals_known ? '' : ' (not published: check the project)') + '</span><input id="tokdec" class="num" type="number" min="0" max="18" value="' + esc(t.decimals) + '"></label></div>' +
          (t.url ? '<p class="small">Project site (from the token registry): <a href="' + esc(/^https?:/.test(t.url) ? t.url : '#') + '" target="_blank" rel="noopener noreferrer">' + esc(t.url) + '</a></p>' : '') +
          '<button class="primary" data-tok="add" data-unit="' + esc(t.unit) + '"' + (t.price ? '' : ' disabled') + '>Add to the coin list</button>' + (t.price ? '' : ' <span class="muted small">Needs a price before it can be added.</span>') + '</div>';
      }).catch(function (er) { res.innerHTML = '<p class="note bad">' + esc(er.message) + '</p>'; });
    }
    if (b.dataset.tok === 'add') return ask({ title: 'Add ' + $('#toksym').value + '?', text: 'Buyers can pick it on checkout straight away (at the end of the list; move it up if you like). Payments go to your Cardano receiving wallet.', ok: 'Add token' })
      .then(function (y) { if (y) return act('tokens/add', { unit: b.dataset.unit, symbol: $('#toksym').value.trim(), name: $('#tokname').value.trim(), decimals: Number($('#tokdec').value) }, 'Added.'); }).catch(fail);
    if (b.dataset.save === 'coins') {
      var s = JSON.parse(JSON.stringify(last.settings)), fe = $('input[name="feat"]:checked', app);
      s.featured = fe ? fe.value : '';
      var ordered = [];
      app.querySelectorAll('tr[data-coin]').forEach(function (tr) {
        var c = s.coins.find(function (x) { return x.id === tr.dataset.coin; });
        ordered.push(c);
        tr.querySelectorAll('[data-f]').forEach(function (i) { var f = i.dataset.f; if (f === 'enabled') c.enabled = i.checked; else if (f === 'discount') c.discount = Number(i.value) || 0; else if (f === 'min_usd') { if (i.value) c.min_usd = Number(i.value); else delete c.min_usd; } else if (i.value) c[f] = i.value; else delete c[f]; });
      });
      s.coins = ordered.concat(s.coins.filter(function (c) { return ordered.indexOf(c) < 0; }));
      var rules = {}; app.querySelectorAll('[data-g]').forEach(function (i) { rules[i.dataset.g] = i.dataset.g === 'tolerance_percent' ? Number(i.value) : parseInt(i.value, 10); });
      return ask({ title: 'Save coins and rules?', text: 'New checkouts use them straight away. Orders that already have a price keep it.', ok: 'Save' }).then(function (y) { if (y) return act('settings', Object.assign({ featured: s.featured, coins: s.coins }, rules), 'Saved.'); }).catch(fail);
    }
    if (b.dataset.save === 'general') {
      var g = last.settings;
      return act('settings', { name: $('#gname').value.trim() || g.name, brand: Object.assign({}, g.brand, { accent: $('#gacc').value, support_url: $('#gsup').value.trim(), terms_url: $('#gterms').value.trim(), privacy_url: $('#gpriv').value.trim() }), email_alerts: { to: $('#eto').value.trim(), from: $('#efrom').value.trim() } }, 'Saved.').catch(fail);
    }
    if (b.dataset.testEmail) return api('POST', 'test-email', {}).then(function (r) { toast(r.message); }).catch(fail);
    if (b.dataset.save === 'soon') return ask({ title: $('#gsoon').checked ? 'Show the coming-soon page?' : 'Open ' + last.settings.name + ' to the public?', text: $('#gsoon').checked ? 'Visitors see the teaser; checkout and the dashboard need the preview code.' : 'The teaser goes away and checkout links work for anyone who has them.', ok: 'Save' })
      .then(function (y) { if (y) return act('settings', { coming_soon: $('#gsoon').checked }, 'Saved.'); }).catch(fail);
    if (b.dataset.save === 'blockfrost' || b.dataset.save === 'blockfrost-off') {
      var key = b.dataset.save === 'blockfrost' ? $('#bfkey').value.trim() : '';
      if (b.dataset.save === 'blockfrost' && !key) return toast('Paste the project id first.');
      return api('POST', 'blockfrost', { project_id: key }).then(function (r) { toast(r.message); return load(); }).catch(fail);
    }
    if (b.dataset.save === 'koios' || b.dataset.save === 'koios-off') {
      var tk = b.dataset.save === 'koios' ? $('#kotok').value.trim() : '';
      if (b.dataset.save === 'koios' && !tk) return toast('Paste the token first.');
      var go = function () { return api('POST', 'koios', { token: tk }).then(function (r) { toast(r.message); return load(); }); };
      if (!tk) return ask({ title: 'Remove the Koios token?', text: 'Cardano will be read with the free anonymous limit (Blockfrost still backs it up).', ok: 'Remove' }).then(function (y) { if (y) return go(); }).catch(fail);
      return go().catch(fail);
    }
    if (b.dataset.save === 'email-key') {
      if (!$('#rskey').value.trim()) return toast('Paste the new key first.');
      return api('POST', 'email-key', { key: $('#rskey').value.trim(), password: $('#rspw').value }).then(function (r) { toast(r.message); return load(); }).catch(fail);
    }
    if (b.dataset.save === 'preview-code') return ask({ title: 'Change the preview code?', text: 'Every other device (and anyone you gave the old code) will need the new one.', ok: 'Change it' })
      .then(function (y) { if (y) return api('POST', 'preview-code', { code: $('#pvcode').value, password: $('#pvpw').value }).then(function (r) { toast(r.message); return load(); }); }).catch(fail);
    if (b.dataset.save === 'password') return api('POST', 'password', { current: $('#pc').value, next: $('#pn').value }).then(function (r) { toast(r.message); showLogin(); }).catch(fail);
    if (b.dataset.wallet === 'preview') {
      var card = b.closest('[data-chain]'), chain = card.dataset.chain, raw = $('.wal', card).value.trim(), spec = specFrom(raw), out = $('.walOut', card);
      return api('POST', 'wallet/preview', { chain: chain, spec: spec }).then(function (p) {
        out.dataset.spec = JSON.stringify(spec);
        out.innerHTML = '<p>' + esc(p.label) + '.</p><p class="muted small">Check that ' + (p.kind === 'account' ? 'these match the first receive addresses in your wallet app' : 'this is your address') + ':</p><ol start="0">' + p.first_addresses.map(function (a) { return '<li><code>' + esc(a) + '</code></li>'; }).join('') + '</ol><button class="primary" data-wallet="save">They match: use this wallet</button>';
      }).catch(function (er) { out.innerHTML = '<p class="note bad">' + esc(er.message) + '</p>'; });
    }
    if (b.dataset.wallet === 'save') {
      var wcard = b.closest('[data-chain]'), wchain = wcard.dataset.chain, sp = JSON.parse($('.walOut', wcard).dataset.spec || '{}');
      return ask({ title: 'Use this receiving wallet?', text: 'New payments go to it from now on. Orders already waiting keep their address and are still watched. An urgent email is sent. Enter the dashboard password to confirm.', input: 'password', ok: 'Use this wallet' })
        .then(function (pw) { if (pw) return act('wallet/set', { chain: wchain, spec: sp, password: pw }).then(function (r) { toast(r.changed ? 'Receiving wallet set. Alert email sent.' : 'That is already the wallet in use.'); }); }).catch(fail);
    }
    if (b.dataset.siteAdd) {
      var id = $('#sid').value.trim().toLowerCase();
      return api('POST', 'sites/' + encodeURIComponent(id) + '/create', { name: $('#sname').value.trim(), notify_url: $('#snotify').value.trim(), return_url: $('#sreturn').value.trim() }).then(showKeys).catch(fail);
    }
    if (b.dataset.siteAct) {
      var sid = b.closest('tr').dataset.site;
      if (b.dataset.siteAct === 'keys') return ask({ title: 'Make new keys for ' + sid + '?', text: 'The old API key and webhook secret stop working at once. The site needs the new ones.', ok: 'Make new keys' }).then(function (y) { if (y) return api('POST', 'sites/' + sid + '/keys', {}).then(showKeys); }).catch(fail);
      return ask({ title: 'Remove ' + sid + '?', text: 'It can no longer create orders. Its past orders stay. Enter the password to confirm.', input: 'password', ok: 'Remove site' }).then(function (pw) { if (pw) return act('sites/' + sid + '/remove', { password: pw }, 'Removed.'); }).catch(fail);
    }
  });
  function showKeys(k) {
    load().catch(function () {});
    return ask({ title: 'Keys for ' + k.id, html: '<p class="note warn">Copy these into the site\'s private settings now. They are not shown again.</p><p class="small muted">API key</p><div class="secret mono">' + esc(k.api_key) + '</div><p class="small muted">Webhook secret</p><div class="secret mono">' + esc(k.webhook_secret) + '</div>', ok: 'I copied them', cancel: false });
  }
  function openOrder(id) {
    api('GET', 'orders/' + id).then(function (d) {
      var o = d.order;
      return ask({ title: (o.item || 'Order') + ' · ' + usd(o.usd), cancel: false, ok: 'Close', html: '<p class="muted">' + esc(o.id) + ' · ' + esc(o.site) + (o.ref ? ' · ' + esc(o.ref) : '') + ' · ' + when(o.created) + ' · ' + esc(STATUS[o.status] || o.status) + '</p>' +
        '<p><a href="' + esc(last.settings.public_url.replace(/\/$/, '') + '/o/' + o.id) + '" target="_blank" rel="noopener noreferrer">Open the buyer\'s page ↗</a></p><h3>Prices given</h3><ul>' +
        d.quotes.map(function (q) { return '<li>' + esc(fmt(q.amount, q.decimals) + ' ' + q.coin) + ' (' + usd(q.usd) + (q.discount ? ', ' + q.discount + '% off' : '') + ') · ' + when(q.created) + (q.shared ? ' · shared address' : '') + '</li>'; }).join('') + '</ul><h3>Money seen</h3><ul>' +
        (d.payments.length ? d.payments.map(function (p) { return '<li>' + esc(fmt(p.amount, p.decimals) + ' ' + p.symbol) + ' · ' + esc(p.state) + (p.reason ? ' (' + esc(p.reason) + ')' : '') + ' · <a href="' + explorer(p) + '" target="_blank" rel="noopener noreferrer">tx</a></li>'; }).join('') : '<li>None</li>') + '</ul>' +
        (d.notices.length ? '<h3>Messages to the site</h3><ul>' + d.notices.map(function (n) { return '<li>' + esc(n.event) + ': ' + (n.done === 1 ? 'delivered' : n.done === 2 ? 'gave up' : 'trying (' + n.attempts + ')') + (n.last_error ? ' · ' + esc(n.last_error) : '') + '</li>'; }).join('') + '</ul>' : '') });
    }).catch(fail);
  }

  api('GET', 'me').then(function (m) { if (m.signed_in) start(); else showLogin(); }).catch(function () { showLogin(); });
})();
