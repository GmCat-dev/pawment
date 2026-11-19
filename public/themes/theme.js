/* Day/Night: follows the device unless the person picks one (remembered on this device). Loaded in <head> so there's no flash. */
(function () {
  var KEY = 'pay-theme';
  var root = document.documentElement;
  try { var t = localStorage.getItem(KEY); if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); } catch (e) { /* private mode */ }
  function current() {
    var t = root.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function label(b) { var dark = current() === 'dark'; b.textContent = dark ? '☀ Day' : '☾ Night'; b.setAttribute('aria-label', dark ? 'Switch to day colours' : 'Switch to night colours'); }
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('themeToggle');
    if (!b) return;
    label(b);
    b.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* ignore */ }
      label(b);
    });
  });
})();
