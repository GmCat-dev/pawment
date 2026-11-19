/* Checkout + receipt page. The order id in the address is the private link; everything else comes from the API. */
(function () {
  'use strict';
  var m = location.pathname.match(/^(.*)\/o\/([a-z0-9_]+)\/?$/);
  var BASE = m ? m[1] : '';
  var ID = m ? m[2] : '';
  var app = document.getElementById('app');
  var view = null, busy = false, pollTimer = null, tickTimer = null, lastError = '', picking = false, canWallet = false, netId = 1, walletMsg = '';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function usd(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  /* Easier-to-read amounts (display only; Copy buttons and QR codes keep the plain number wallets need):
     commas in whole numbers (6,140,000) and, for 8-decimal coins like Bitcoin, the fraction grouped from the satoshi end (0.00,007,680). */
  function nice(v, decimals) {
    var s = String(v == null ? '' : v), neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
    var parts = s.split('.'), w = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','), f = parts[1] || '';
    if (decimals === 8) { f = (f + '00000000').slice(0, 8); f = f.slice(0, 2) + ',' + f.slice(2, 5) + ',' + f.slice(5); }
    return (neg ? '-' : '') + w + (f ? '.' + f : '');
  }
  function when(t) { return t ? new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''; }
  function nowS() { return Math.floor(Date.now() / 1000); }
  function coinName(id) { var c = (view.coins || []).find(function (x) { return x.id === id; }); if (c) return c.symbol; if (view.quote && view.quote.coin === id) return view.quote.symbol; return id; }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : ''; }

  function api(path, body) {
    return fetch(BASE + '/api/pay/' + ID + (path ? '/' + path : ''), body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) { var e = new Error(d.message || 'Something went wrong.'); e.code = d.error; throw e; } return d; }); });
  }

  /* ---------- in-page dialog (never the browser's own boxes) ---------- */
  var dlg = document.getElementById('dlg');
  function ask(o) {
    return new Promise(function (resolve) {
      dlg.innerHTML = '<h2>' + esc(o.title) + '</h2>' + (o.text ? '<p>' + esc(o.text) + '</p>' : '') +
        '<div class="actions">' + (o.cancel === false ? '' : '<button type="button" class="btn-soft" data-v="0">' + esc(o.cancel || 'Cancel') + '</button>') +
        '<button type="button" class="btn-main" data-v="1">' + esc(o.ok || 'OK') + '</button></div>';
      function done(v) { dlg.close(); dlg.onclick = null; resolve(v); }
      dlg.onclick = function (e) { var b = e.target.closest('button'); if (b) done(b.dataset.v === '1'); else if (e.target === dlg) done(false); };
      dlg.oncancel = function (e) { e.preventDefault(); done(false); };
      dlg.showModal();
      var first = dlg.querySelector(o.focusOk ? '[data-v="1"]' : 'button'); if (first) first.focus();
    });
  }

  function copy(text, btn) {
    var ok = function () { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, function () { fallback(); });
    else fallback();
    function fallback() { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); ok(); } catch (e) { /* ignore */ } ta.remove(); }
  }

  function qrSvg(text) {
    if (!window.qrcode) return '';
    var qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
    var n = qr.getModuleCount(), q = 4, d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) d += 'M' + (c + q) + ',' + (r + q) + 'h1v1h-1z';
    return '<svg class="qr" viewBox="0 0 ' + (n + 2 * q) + ' ' + (n + 2 * q) + '" role="img" aria-label="QR code with the address and amount"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#1d1430"/></svg>';
  }

  /* ---------- brand ---------- */
  function brand() {
    var b = view.brand || {};
    document.getElementById('brand').textContent = b.name || 'Payment';
    document.title = (view.status === 'paid' ? 'Receipt' : 'Pay') + ' · ' + (b.name || 'Payment');
    if (b.logo) { var l = document.getElementById('logo'); l.src = /^https?:/.test(b.logo) ? b.logo : BASE + '/' + b.logo.replace(/^\//, ''); l.hidden = false; }
    if (!b.theme && /^#[0-9a-f]{6}$/i.test(b.accent || '')) document.documentElement.style.setProperty('--accent', b.accent);
    var f = [];
    if (safeUrl(b.support_url)) f.push('<a href="' + esc(b.support_url) + '" rel="noopener">Help</a>');
    if (safeUrl(b.terms_url)) f.push('<a href="' + esc(b.terms_url) + '" rel="noopener">Terms</a>');
    if (safeUrl(b.privacy_url)) f.push('<a href="' + esc(b.privacy_url) + '" rel="noopener">Privacy</a>');
    f.push('<span>Payments go straight to the seller\'s own wallet. Powered by Pawment.</span>');
    f.push('<span class="beta">Beta software, still under development.</span>');
    document.getElementById('foot').innerHTML = f.join('');
  }

  /* ---------- pieces ---------- */
  function orderCard() {
    return '<section class="card"><div class="row"><div><div class="muted small">Paying ' + esc(view.site) + '</div><h1>' + esc(view.item || 'Your order') + '</h1></div>' +
      '<div class="price">' + usd(view.usd) + '</div></div>' +
      (view.test ? '<div class="testbar">Test mode: this uses test networks. Real coins sent here would be lost.</div>' : '') + '</section>';
  }

  function coinPicker() {
    // the owner's order, featured coin first; a network heading wherever the network changes
    var multi = view.coins.some(function (c) { return c.chain !== view.coins[0].chain; });
    var prev = null;
    var list = view.coins.map(function (c) {
      var head = multi && !c.featured && c.chain_name !== prev ? '<h3 class="net-h">' + esc(c.chain_name) + '</h3>' : '';
      if (!c.featured) prev = c.chain_name;
      return head + coinButton(c);
    }).join('');
    return '<section class="card"><h2>Pay with</h2><div class="coins">' + (list || '<p class="muted">No coin can be used right now. Please try again later.</p>') + '</div>' +
      (lastError ? '<p class="err">' + esc(lastError) + '</p>' : '') +
      '<p class="muted small">You pay from your own wallet app. The price in coins is held for 30 minutes once you pick.</p></section>';
  }
  function coinButton(c) {
    {
      var off = c.discount > 0;
      return '<button type="button" class="coin' + (c.featured ? ' featured' : '') + '" data-coin="' + esc(c.id) + '"' + (c.available ? '' : ' disabled') + '>' +
        '<span><span class="name">' + esc(c.symbol) + '</span>' + (c.badge ? '<span class="badge">' + esc(c.badge) + '</span>' : '') +
        '<span class="sub">' + esc(c.name) + (c.kind === 'stable' ? ' · dollar coin' : '') + (c.available ? '' : ' · not available right now') + '</span></span>' +
        '<span class="amt">' + (off ? '<span class="was">' + usd(view.usd) + '</span>' : '') + '<strong>' + usd(c.usd) + '</strong></span></button>';
    }
  }


  function statusLine(q) {
    var waiting = Number(q.waiting) > 0, got = Number(q.received) > 0;
    var mins = Math.max(1, Math.round((view.blocks_needed || 3) * (view.minutes_per_block || 0.33)));
    if (view.status === 'part_paid') return '<div class="status"><span class="dot warn"></span>Received ' + esc(nice(q.received, q.decimals)) + ' of ' + esc(nice(q.amount, q.decimals)) + ' ' + esc(coinName(q.coin)) + '. Please send the rest: ' + esc(nice(q.left, q.decimals)) + '.</div>';
    if (waiting) return '<div class="status"><span class="dot wait"></span>Payment seen. Waiting for the network to confirm it (about ' + mins + ' min). You can close this page.</div>';
    if (got) return '<div class="status"><span class="dot ok"></span>Received.</div>';
    return '<div class="status"><span class="dot wait"></span>Waiting for your payment…</div>';
  }

  function payPanel() {
    var q = view.quote, c = view.coins.find(function (x) { return x.id === q.coin; }) || { symbol: q.coin, kind: '' };
    var part = view.status === 'part_paid' && Number(q.left) > 0;
    var amount = part ? q.left : q.amount;
    var uri = part && q.left_uri ? q.left_uri : q.uri;
    var expired = q.expires_at <= nowS();
    var started = Number(q.received) > 0 || Number(q.waiting) > 0;
    var token = Boolean(q.token);
    var net = q.chain_name || 'Cardano', isCardano = q.chain === 'cardano';
    var FEE = { eth: 'ETH', bsc: 'BNB', polygon: 'POL', trx: 'TRX' };
    var WARN = {
      eth: 'Use the <strong>' + esc(net) + '</strong> network (ERC-20 for tokens), not BNB Chain or Polygon.',
      bsc: 'Use <strong>' + esc(net) + '</strong> (BEP-20), not Ethereum or opBNB.',
      polygon: 'Use the <strong>' + esc(net) + '</strong> network, not Ethereum.',
      trx: 'Use the <strong>' + esc(net) + '</strong> network (TRC-20 for USDT), not Ethereum or BNB Chain.' + (token ? ' A USDT transfer on TRON costs a few TRX in network fees.' : ''),
      xmr: 'Send <strong>Monero (XMR)</strong> on the Monero network.',
      bch: 'This is <strong>Bitcoin Cash (BCH)</strong>: don\'t send Bitcoin (BTC) here.',
      btc: 'Send <strong>Bitcoin (BTC)</strong> only: not Bitcoin Cash or wrapped BTC.' };
    var h = '<section class="card pay">' + statusLine(q);
    if (q.covered) {
      h += '<p>' + esc(nice(Number(q.received) > 0 ? q.received : q.waiting, q.decimals)) + ' ' + esc(c.symbol) + ' is on its way. Nothing more to do: this page turns into your receipt when it is confirmed.</p>' + paymentsTable() + '</section>';
      return h;
    }
    if (expired && !started) {
      h += '<div class="note note-warn">The held price has run out. If you already sent the payment, it still counts for 24 hours: you don\'t need to do anything. If not, get a fresh price below.</div>' +
        '<div class="actions"><button type="button" class="btn-main" data-fresh="' + esc(q.coin) + '">Get a fresh price</button>' +
        '<button type="button" class="btn-soft" data-change="1">Pick another coin</button></div>';
    } else {
      var kind = isCardano ? 'cardano' : q.pay && q.pay.type;
      var wl = kind === 'cardano' ? (canWallet ? wallets() : []) : kind === 'evm' ? evmWallets() : kind === 'tron' ? tronWallets() : [];
      if (wl.length) h += '<div class="walletpay"><button type="button" class="btn-main wide" data-wallet="' + kind + '">' + ({ cardano: 'Pay with a Cardano wallet', evm: 'Pay with a browser wallet', tron: 'Pay with TronLink' }[kind]) + '</button>' +
        '<p class="muted small">Opens ' + esc(wl.map(function (w) { return w.name; }).join(', ')) + '. Your wallet shows the exact payment before you confirm.</p>' +
        (walletMsg ? '<p class="small" id="wmsg">' + walletMsg + '</p>' : '') + '</div><p class="or"><span>or scan / copy</span></p>';
      h += '<div class="qrwrap">' + qrSvg(uri) + '</div>' +
        '<div class="field"><span class="label">Send exactly</span><div class="value"><span class="big">' + esc(nice(amount, q.decimals)) + ' ' + esc(c.symbol) + '</span>' +
        '<button type="button" class="btn-soft btn-small" data-copy="' + esc(amount) + '">Copy</button></div>' +
        (part ? '<span class="muted small">The rest of your ' + usd(q.usd) + ' payment</span>' : q.discount > 0 ? '<span class="muted small">' + usd(q.usd) + ' after your ' + esc(q.discount) + '% ' + esc(c.symbol) + ' discount</span>' : '<span class="muted small">' + usd(q.usd) + '</span>') + '</div>' +
        '<div class="field"><span class="label">To this ' + esc(net) + ' address</span><div class="mono">' + esc(q.address) + '</div>' +
        '<div class="value"><button type="button" class="btn-soft btn-small" data-copy="' + esc(q.address) + '">Copy address</button>' +
        '<span class="muted small">Check it ends in <span class="ending">' + esc(q.address.slice(-6)) + '</span></span></div></div>';
      if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && (!token || q.chain !== 'cardano')) h += '<div class="actions"><a class="btn ' + (wl.length ? 'btn-soft' : 'btn-main') + '" href="' + esc(uri) + '">Open in wallet app</a></div>';
      h += '<div class="note note-info">' + (WARN[q.chain] || 'Send on the <strong>' + esc(net) + '</strong> network only.') +
        (token && isCardano ? ' Cardano always sends a little ADA (about 1–1.5) along with a token; your wallet adds it by itself.' : '') +
        (FEE[q.chain] ? ' You need a little ' + FEE[q.chain] + ' for the network fee.' : !isCardano ? ' Your wallet adds the network fee on top.' : '') +
        (q.shared ? ' Send the exact amount: that is how we know it is yours. From an exchange? Check that the exact amount arrives (some take their fee out of it).' : '') + '</div>';
      if (!started) h += '<p class="muted small" id="held">Price held for <strong id="left"></strong>.</p>';
      if (!started) h += '<div><button type="button" class="btn-link" data-change="1">Pick another coin</button></div>';
    }
    if (view.demo) h += '<div class="demo-pay"><p class="small"><strong>Demo:</strong> no real coins. Pretend a wallet paid:</p><div class="actions"><button type="button" class="btn" data-demo="exact">Pay the exact amount</button>' +
      '<button type="button" class="btn-soft" data-demo="less">Pay too little</button><button type="button" class="btn-soft" data-demo="more">Pay too much</button></div><p class="muted small">The pretend network adds a block every few seconds, so it confirms quickly.</p></div>';
    h += claimBox() + '</section>';
    return h;
  }

  function claimBox() {
    return '<details id="claim"><summary>I already paid</summary><p class="muted small">Paste the transaction ID from your wallet\'s history and we\'ll look for it.</p>' +
      '<form class="stack" data-form="claim"><label class="sr" for="tx">Transaction ID</label><input id="tx" name="tx" class="mono" autocomplete="off" spellcheck="false" placeholder="64 letters and numbers">' +
      '<button type="submit" class="btn-soft">Look for my payment</button><p class="small" id="claim-msg"></p></form></details>';
  }

  function paymentsTable() {
    if (!view.payments.length) return '';
    return '<table class="list">' + view.payments.map(function (p) {
      return '<tr><td>' + esc(when(p.confirmed_at || p.seen_at)) + '<br><a class="small" href="' + esc(p.explorer) + '" target="_blank" rel="noopener">View on the blockchain</a></td>' +
        '<td>' + esc(nice(p.amount, p.decimals)) + ' ' + esc(p.symbol || p.coin) + '<br><span class="muted small">' + (p.state === 'counted' ? 'confirmed' : p.state === 'seen' ? 'confirming' : 'being checked') + '</span></td></tr>';
    }).join('') + '</table>';
  }

  function refundsBlock() {
    var h = '';
    if (view.refunds.length) {
      h += '<h2>Refunds</h2><table class="list">' + view.refunds.map(function (r) {
        var st = { requested: 'Asked for: the seller will reply', approved: 'Approved: on its way to you', sent: 'Refunded', declined: 'Not approved' }[r.status] || r.status;
        return '<tr><td>' + esc(when(r.created)) + '<br><span class="mono small">to …' + esc(r.address.slice(-10)) + '</span>' +
          (r.explorer ? '<br><a class="small" href="' + esc(r.explorer) + '" target="_blank" rel="noopener">View refund</a>' : '') + '</td>' +
          '<td>' + esc(nice(r.amount, r.decimals)) + ' ' + esc(r.symbol || r.coin) + '<br><span class="muted small">' + esc(st) + '</span></td></tr>';
      }).join('') + '</table>';
    }
    if (view.can_refund) {
      h += '<details><summary>' + (view.extra ? 'Ask for the extra back' : 'Ask for a refund') + '</summary>' +
        '<p class="muted small">You can ask until ' + esc(when(view.refund_until)) + '. The seller looks at each request (refunds for what you bought follow the seller\'s own rules) and sends refunds by hand; the network fee for sending it back comes out of the refund. Give a ' + esc((view.quote && view.quote.chain_name) || 'Cardano') + ' address you own: we never send it back to the address you paid from automatically, because exchanges share those.</p>' +
        '<form class="stack" data-form="refund"><label class="label" for="raddr">Your ' + esc((view.quote && view.quote.chain_name) || 'Cardano') + ' address for the refund</label><input id="raddr" name="address" class="mono" autocomplete="off" spellcheck="false" placeholder="' + ({ cardano: 'addr1…', btc: 'bc1… / 1… / 3…', ltc: 'ltc1… / L… / M…', bch: 'bitcoincash:q…', grs: 'grs1… / F… / 3…', eth: '0x…', bsc: '0x…', polygon: '0x…', trx: 'T…', xmr: '4… / 8…' }[(view.quote || {}).chain] || '') + '">' +
        '<label class="label" for="rnote">Why (optional)</label><textarea id="rnote" name="note" maxlength="500"></textarea>' +
        '<button type="submit" class="btn-soft">Ask for a refund</button><p class="err" id="refund-msg"></p></form></details>';
    }
    return h;
  }

  function receipt() {
    var q = view.quote;
    var h = '<section class="card done"><div class="tick" aria-hidden="true">✓</div><h1>Paid. Thank you!</h1>' +
      '<p>' + esc(view.item || 'Your order') + ' · ' + esc(view.site) + '</p>' +
      '<p class="price">' + esc(nice(q.received, q.decimals)) + ' ' + esc(coinName(q.coin)) + '</p>' +
      (view.test ? '<div class="testbar">Test mode: test network, play money.</div>' : '') +
      '<p class="muted small">' + usd(q.usd) + (q.discount > 0 ? ' (with ' + esc(q.discount) + '% off)' : '') + ' · ' + esc(when(view.paid_at)) + '</p>' +
      (view.return_url && safeUrl(view.return_url) ? '<div class="actions center"><a class="btn btn-main" href="' + esc(view.return_url) + '">Back to ' + esc(view.site) + '</a></div>' : '') +
      '</section><section class="card">' +
      (view.extra ? '<div class="note note-warn">You sent ' + esc(nice(view.extra, q.decimals)) + ' ' + esc(coinName(q.coin)) + ' more than the price. You can ask for it back below.</div>' : '') +
      '<h2>Receipt</h2>' + paymentsTable() +
      '<p class="muted small">Keep this page\'s link: it is your receipt. Anyone with the link can see this page. <button type="button" class="btn-link" data-copy-link="1">Copy link</button></p>' +
      refundsBlock() + '</section>';
    return h;
  }

  function render() {
    brand();
    if (view.demo && !document.getElementById('demo-bar')) { var bar = document.createElement('div'); bar.id = 'demo-bar'; bar.className = 'demo-bar'; bar.innerHTML = 'Demo checkout: pretend money on test networks. <a href="/">About Pawment</a>'; document.body.insertBefore(bar, document.body.firstChild); }
    var s = view.status, h = orderCard();
    if (s === 'paid') h = receipt();
    else if (s === 'expired') h += '<section class="card"><h2>This payment request has closed</h2><p>Nothing was received for it. If you still want to pay, please start again from ' + esc(view.site) + '.</p>' + backLink() + '</section>';
    else if (s === 'cancelled') h += '<section class="card"><h2>This order was cancelled</h2>' + backLink() + '</section>';
    else if (s === 'check') h += '<section class="card"><div class="status"><span class="dot warn"></span>We\'re checking your payment by hand.</div><p>Something about it needs a person to look (for example the amount was a little different, or it came late). You don\'t need to do anything: the seller will sort it out, and this page will update.</p>' + paymentsTable() + refundsBlock() + '</section>';
    else if (view.quote && !picking) h += payPanel();
    else h += coinPicker();
    // keep what the buyer is typing
    var keep = {}; app.querySelectorAll('input, textarea').forEach(function (i) { if (i.id) keep[i.id] = i.value; });
    var open = {}; app.querySelectorAll('details[id]').forEach(function (d) { open[d.id] = d.open; });
    app.innerHTML = h;
    Object.keys(keep).forEach(function (k) { var el = document.getElementById(k); if (el) el.value = keep[k]; });
    Object.keys(open).forEach(function (k) { var el = document.getElementById(k); if (el) el.open = open[k]; });
    tick();
  }
  function backLink() { return view.return_url && safeUrl(view.return_url) ? '<div class="actions"><a class="btn btn-soft" href="' + esc(view.return_url) + '">Back to ' + esc(view.site) + '</a></div>' : ''; }

  function tick() {
    var el = document.getElementById('left');
    if (!el || !view.quote) return;
    var s = view.quote.expires_at - nowS();
    if (s <= 0) { load(); return; }
    el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /* ---------- actions ---------- */
  app.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || busy) return;
    if (b.dataset.copy) return copy(b.dataset.copy, b);
    if (b.dataset.wallet === 'evm') return evmPay(b);
    if (b.dataset.wallet === 'tron') return tronPay(b);
    if (b.dataset.wallet) return walletPay(b);
    if (b.dataset.copyLink) return copy(location.href, b);
    if (b.dataset.demo) { busy = true; b.disabled = true; return fetch('/api/demo/pay/' + encodeURIComponent(view.id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ how: b.dataset.demo }) })
      .then(function () { return load(); }).catch(function () {}).then(function () { busy = false; }); }
    if (b.dataset.change) { picking = true; lastError = ''; render(); return; }
    var coin = b.dataset.coin || b.dataset.fresh;
    if (coin) {
      busy = true; b.disabled = true; lastError = '';
      api('quote', { coin: coin }).then(function (v) { picking = false; view = v; render(); schedule(); })
        .catch(function (err) { lastError = err.message; render(); }).then(function () { busy = false; });
    }
  });
  app.addEventListener('submit', function (e) {
    var f = e.target.closest('form'); if (!f) return; e.preventDefault(); if (busy) return;
    if (f.dataset.form === 'claim') {
      var msg = document.getElementById('claim-msg'); busy = true; msg.textContent = 'Looking…';
      api('claim', { tx: f.tx.value.trim() }).then(function (r) { msg.textContent = r.message; if (r.view) { view = r.view; setTimeout(render, 2500); } })
        .catch(function (err) { msg.textContent = err.message; }).then(function () { busy = false; });
    }
    if (f.dataset.form === 'refund') {
      var out = document.getElementById('refund-msg'); out.textContent = '';
      var addr = f.address.value.trim();
      if (addr.length < 20) { out.textContent = 'That address looks too short.'; return; }
      ask({ title: 'Ask for a refund?', text: 'The refund goes to the address ending …' + addr.slice(-8) + '. Please check that ending against your wallet. A refund sent to a wrong address can\'t be taken back.', ok: 'Ask for refund', cancel: 'Go back' })
        .then(function (yes) {
          if (!yes) return;
          busy = true;
          return api('refund', { address: addr, note: f.note.value }).then(function (v) { view = v; render(); return ask({ title: 'Refund asked for', text: 'The seller will look at it soon. This page shows when it is on its way.', ok: 'OK', cancel: false, focusOk: true }); })
            .catch(function (err) { out.textContent = err.message; }).then(function () { busy = false; });
        });
    }
  });

  /* ---------- wallet Pay button (CIP-30) ---------- */
  function wallets() {
    var c = window.cardano || {}, seen = {}, out = [];
    Object.keys(c).forEach(function (k) {
      var w = c[k];
      if (!w || typeof w !== 'object' || typeof w.enable !== 'function' || !w.name || seen[w.name] || /^(typhon|ccvault)$/.test(k) && seen.Typhon) return;
      seen[w.name] = 1; out.push({ key: k, name: String(w.name).slice(0, 30), icon: /^data:image\//.test(w.icon || '') ? w.icon : '' });
    });
    return out;
  }
  function pickWallet(list) {
    return new Promise(function (resolve) {
      dlg.innerHTML = '<h2>Pay with which wallet?</h2><div class="wlist">' + list.map(function (w, i) {
        return '<button type="button" class="btn-soft wbtn" data-i="' + i + '">' + (w.icon ? '<img alt="" src="' + esc(w.icon) + '">' : '') + esc(w.name) + '</button>';
      }).join('') + '</div><div class="actions"><button type="button" class="btn-soft" data-x="1">Cancel</button></div>';
      function done(v) { dlg.close(); dlg.onclick = null; resolve(v); }
      dlg.onclick = function (e) { var b = e.target.closest('button'); if (b && b.dataset.i) done(list[Number(b.dataset.i)]); else if ((b && b.dataset.x) || e.target === dlg) done(null); };
      dlg.oncancel = function (e) { e.preventDefault(); done(null); };
      dlg.showModal(); var f = dlg.querySelector('.wbtn'); if (f) f.focus();
    });
  }
  function say(t) { walletMsg = t; var el = document.getElementById('wmsg'); if (el) el.innerHTML = t; else render(); }
  function cancelled(e) { var c = e && (e.code !== undefined ? e.code : e.info && e.info.code); var m = String((e && (e.info || e.message)) || ''); return c === 2 || c === -3 || c === 1 && /declin|reject|cancel/i.test(m) || /declin|reject|cancel|refus/i.test(m); }
  function walletPay(btn) {
    var list = wallets();
    if (!list.length) return;
    pickWallet(list).then(function (w) {
      if (!w) return;
      busy = true; btn.disabled = true; say('Connecting to ' + esc(w.name) + '…');
      var wapi;
      return window.cardano[w.key].enable().then(function (a) { wapi = a; return wapi.getNetworkId(); }).then(function (n) {
        if (n !== netId) throw new Error(netId === 1 ? 'Your wallet is on a test network. Switch it to the main Cardano network and try again.' : 'Your wallet is on the main network, but this is a test checkout.');
        return Promise.all([wapi.getUtxos(), wapi.getChangeAddress()]);
      }).then(function (r) {
        if (!r[0] || !r[0].length) throw new Error('This wallet account has no coins to pay with.');
        say('Preparing the payment…');
        return api('wallet-build', { utxos: r[0], change: r[1] });
      }).then(function (b) {
        say('Check the payment in ' + esc(w.name) + ' and sign it there.' + (Number(b.extra_ada) ? ' (It includes ' + (Number(b.extra_ada) / 1e6).toFixed(2) + ' ADA that Cardano sends along with tokens.)' : ''));
        return wapi.signTx(b.tx, false).then(function (wit) { return api('wallet-finish', { tx: b.tx, witness: wit }); });
      }).then(function (d) {
        return Promise.resolve(wapi.submitTx(d.signed)).catch(function () { /* we send it too */ }).then(function () {
          var link = (view.network === 'testnet' ? 'https://preprod.cardanoscan.io/transaction/' : 'https://cardanoscan.io/transaction/') + d.hash;
          try { sessionStorage.setItem('sent-' + ID, d.hash); } catch (e) { /* ignore */ }
          say('<strong>Sent!</strong> Waiting for the network to pick it up (usually under a minute). <a href="' + esc(link) + '" target="_blank" rel="noopener">View it</a>');
          setTimeout(load, 15000); setTimeout(load, 35000);
        });
      }).catch(function (e) {
        say('<span class="err">' + esc(cancelled(e) ? 'Cancelled in your wallet. Nothing was sent.' : (e && e.message) || 'Your wallet could not make this payment. Please use the QR code below.') + '</span>');
      }).then(function () { busy = false; btn.disabled = false; });
    });
  }

  /* ---------- browser wallet button for Ethereum, BNB Smart Chain, Polygon (EIP-1193 / EIP-6963) ---------- */
  var evmFound = [];
  window.addEventListener('eip6963:announceProvider', function (e) {
    var d = e.detail || {};
    if (!d.provider || !d.info || evmFound.some(function (x) { return x.info.uuid === d.info.uuid; })) return;
    evmFound.push(d);
  });
  try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (e) { /* old browser */ }
  function evmWallets() {
    var list = evmFound.map(function (d) { return { name: String(d.info.name || 'Wallet').slice(0, 30), icon: /^data:image\//.test(d.info.icon || '') ? d.info.icon : '', provider: d.provider }; });
    if (!list.length && window.ethereum && typeof window.ethereum.request === 'function') list.push({ name: window.ethereum.isMetaMask ? 'MetaMask' : 'your browser wallet', icon: '', provider: window.ethereum });
    return list;
  }
  var hexOf = function (v) { return '0x' + BigInt(v).toString(16); };
  var pad = function (h) { return h.replace(/^0x/, '').toLowerCase().padStart(64, '0'); };
  function evmPay(btn) {
    var list = evmWallets(), q = view.quote, info = q.pay;
    if (!list.length) return;
    pickWallet(list).then(function (w) {
      if (!w) return;
      var pr = w.provider, from;
      busy = true; btn.disabled = true; say('Connecting to ' + esc(w.name) + '…');
      return pr.request({ method: 'eth_requestAccounts' }).then(function (acc) {
        from = acc && acc[0];
        if (!from) throw new Error('No account was shared by the wallet.');
        return pr.request({ method: 'eth_chainId' });
      }).then(function (cid) {
        if (parseInt(cid, 16) === info.chain_id) return;
        say('Switching ' + esc(w.name) + ' to ' + esc(info.chain_name) + '…');
        return pr.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: info.add.chainId }] }).catch(function (e) {
          if (e && (e.code === 4902 || /unrecognized|not added|unknown chain/i.test(e.message || ''))) return pr.request({ method: 'wallet_addEthereumChain', params: [info.add] });
          throw e;
        });
      }).then(function () {
        var left = view.status === 'part_paid' ? null : q.units;
        if (!left) throw new Error('Please send the rest with the QR code.');
        say('Check the payment in ' + esc(w.name) + ' and confirm it there.');
        var tx = info.contract
          ? { from: from, to: info.contract, value: '0x0', data: '0xa9059cbb' + pad(q.address) + pad(hexOf(left)) }
          : { from: from, to: q.address, value: hexOf(left) };
        return pr.request({ method: 'eth_sendTransaction', params: [tx] });
      }).then(function (hash) {
        try { sessionStorage.setItem('sent-' + ID, hash); } catch (e) { /* ignore */ }
        say('<strong>Sent!</strong> Waiting for the network to pick it up…');
        return sentLookup(hash);
      }).catch(function (e) {
        var c = e && e.code;
        say('<span class="err">' + esc(c === 4001 || /reject|denied|cancel/i.test((e && e.message) || '') ? 'Cancelled in your wallet. Nothing was sent.' : (e && e.message) || 'Your wallet could not make this payment. Please use the QR code below.') + '</span>');
      }).then(function () { busy = false; btn.disabled = false; });
    });
  }
  function sentLookup(hash) {
        var tries = 0;
        function look() {
          return api('claim', { tx: hash }).then(function (r) {
            if (r.found) { say('<strong>Sent!</strong> ' + esc(r.message)); if (r.view) { view = r.view; setTimeout(render, 2500); } return; }
            if (++tries < 6) { say('<strong>Sent!</strong> Waiting for the network to pick it up…'); setTimeout(look, 10000); }
            else { say('<strong>Sent!</strong> It will show here once the network has it.'); setTimeout(load, 15000); }
          }).catch(function () { say('<strong>Sent!</strong> It will show here once the network has it (usually under a minute).'); setTimeout(load, 15000); });
        }
        return look();
  }
  /* ---------- TronLink button for TRON ---------- */
  function tronWallets() { return window.tronLink || window.tronWeb ? [{ name: 'TronLink', icon: '' }] : []; }
  function tronPay(btn) {
    var q = view.quote, info = q.pay;
    busy = true; btn.disabled = true; say('Connecting to TronLink…');
    var ask = window.tronLink && typeof window.tronLink.request === 'function' ? window.tronLink.request({ method: 'tron_requestAccounts' }) : Promise.resolve({ code: 200 });
    Promise.resolve(ask).then(function (r) {
      if (r && r.code && r.code !== 200) throw new Error(r.code === 4001 ? 'cancel' : 'TronLink did not connect (is it unlocked?).');
      var tw = (window.tronLink && window.tronLink.tronWeb) || window.tronWeb;
      if (!tw || !tw.defaultAddress || !tw.defaultAddress.base58) throw new Error('Please unlock TronLink and try again.');
      var host = String((tw.fullNode && tw.fullNode.host) || '');
      if (view.network !== 'testnet' && /nile|shasta/i.test(host)) throw new Error('TronLink is on a test network. Switch it to the TRON main network.');
      if (view.status === 'part_paid') throw new Error('Please send the rest with the QR code.');
      say('Check the payment in TronLink and confirm it there.');
      if (!info.contract) return tw.trx.sendTransaction(q.address, Number(q.units)).then(function (res) { return res.txid || (res.transaction && res.transaction.txID); });
      return tw.contract().at(info.contract).then(function (ct) { return ct.transfer(q.address, q.units).send({ feeLimit: 100000000 }); });
    }).then(function (txid) {
      if (!txid) throw new Error('TronLink did not return the payment id. If you sent it, use "I already paid" below.');
      say('<strong>Sent!</strong> Waiting for the network to pick it up…');
      return sentLookup(String(txid));
    }).catch(function (e) {
      var m = String((e && (e.message || e)) || '');
      say('<span class="err">' + esc(/cancel|reject|denied|declined/i.test(m) ? 'Cancelled in TronLink. Nothing was sent.' : m || 'TronLink could not make this payment. Please use the QR code below.') + '</span>');
    }).then(function () { busy = false; btn.disabled = false; });
  }

  /* ---------- loading and refreshing ---------- */
  function load() {
    return api('').then(function (v) { view = v; canWallet = Boolean(v.wallet_pay); netId = v.network_id; if (!picking || v.status !== 'open') render(); schedule(); })
      .catch(function (err) { app.innerHTML = '<section class="card"><h2>Can\'t open this payment</h2><p>' + esc(err.message) + '</p></section>'; });
  }
  function schedule() {
    clearTimeout(pollTimer);
    if (!view) return;
    var s = view.status;
    var waitingRefund = (view.refunds || []).some(function (r) { return r.status === 'requested' || r.status === 'approved'; });
    var ms = ['open', 'seen', 'part_paid'].indexOf(s) >= 0 && view.quote ? 5000 : s === 'check' || waitingRefund ? 20000 : s === 'paid' ? 60000 : 30000;
    if (s === 'expired' || s === 'cancelled') return;
    pollTimer = setTimeout(function () { if (!document.hidden && !busy && !(dlg && dlg.open)) load(); else schedule(); }, ms);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && view) load(); });
  tickTimer = setInterval(tick, 1000);
  if (!ID) { app.innerHTML = '<section class="card"><h2>Payment link not found</h2></section>'; return; }
  load();
})();
