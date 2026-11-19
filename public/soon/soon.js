/* Coming-soon page: the preview-code pop-up (an in-page dialog, never the browser's own box). */
(function () {
  'use strict';
  var dlg = document.getElementById('codeDlg'), form = document.getElementById('codeForm'), input = document.getElementById('code');
  var msg = document.getElementById('codeMsg'), done = document.getElementById('unlocked');
  function showUnlocked() { form.hidden = true; done.hidden = false; }
  function open() {
    msg.textContent = ''; input.classList.remove('bad');
    if (!dlg.open) dlg.showModal();
    if (!form.hidden) input.focus();
  }
  document.querySelectorAll('[data-open-code]').forEach(function (b) { b.addEventListener('click', open); });
  dlg.querySelector('[data-close]').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });   // a click outside closes it too
  input.addEventListener('input', function () { msg.textContent = ''; input.classList.remove('bad'); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = input.value.trim();
    if (!code) { msg.textContent = 'Please type the code.'; input.focus(); return; }
    var btn = form.querySelector('button'); btn.disabled = true;
    fetch('/api/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (r) {
        if (r.ok) { showUnlocked(); return; }
        msg.textContent = (r.d && r.d.message ? r.d.message : "That code isn't right.") + (r.d && r.d.error === 'code' ? ' Try again, or close this with the ×.' : '');
        input.classList.add('bad'); input.select();
      })
      .catch(function () { msg.textContent = 'Could not check the code. Please try again.'; })
      .then(function () { btn.disabled = false; });
  });
  // already unlocked on this device?
  fetch('/api/preview').then(function (r) { return r.json(); }).then(function (d) {
    if (d.unlocked) {
      showUnlocked();
      document.querySelectorAll('[data-open-code]').forEach(function (b) { b.textContent = b.classList.contains('link') ? 'Preview (unlocked)' : 'Open the preview'; });
    }
  }).catch(function () {});
})();
