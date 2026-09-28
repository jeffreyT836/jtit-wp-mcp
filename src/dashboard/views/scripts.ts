/**
 * Served at /assets/app.js (CSP allows only same-origin scripts). Progressive enhancement
 * only: every page works without it.
 */
export const APP_JS = `
(function () {
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function store(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }

  // Collapsible panels: remember open/closed per panel, open the one the URL hash targets.
  var panels = document.querySelectorAll('details[data-persist]');
  panels.forEach(function (d) {
    var key = 'panel:' + d.getAttribute('data-persist');
    var saved = store(function (s) { return s.getItem(key); });
    if (saved === 'open') d.open = true;
    if (saved === 'closed') d.open = false;
    d.addEventListener('toggle', function () {
      store(function (s) { s.setItem(key, d.open ? 'open' : 'closed'); });
    });
  });
  function openHash() {
    if (!location.hash || location.hash.length < 2) return;
    var el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (!el) return;
    for (var p = el; p; p = p.parentElement) { if (p.tagName === 'DETAILS') p.open = true; }
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }
  openHash();
  window.addEventListener('hashchange', openHash);
  // A panel with a form error inside is always opened.
  document.querySelectorAll('details .flash.error').forEach(function (f) {
    for (var p = f.parentElement; p; p = p.parentElement) { if (p.tagName === 'DETAILS') p.open = true; }
  });

  // Count-up numbers.
  document.querySelectorAll('[data-count]').forEach(function (el) {
    var target = parseInt(el.getAttribute('data-count'), 10);
    if (reduced || !(target > 0)) return;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / 900);
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) requestAnimationFrame(step);
    }
    el.textContent = '0';
    requestAnimationFrame(step);
  });

  // Spotlight that follows the mouse on the site header.
  document.querySelectorAll('.hero').forEach(function (el) {
    el.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      el.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  });

  // Toasts: success messages fade out by themselves; all can be closed.
  function dismiss(t) { t.classList.add('hide'); setTimeout(function () { t.remove(); }, 400); }
  document.querySelectorAll('.toast.ok').forEach(function (t) { setTimeout(function () { dismiss(t); }, 6000); });

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var close = t.closest('[data-dismiss]');
    if (close) { var toast = close.closest('.toast'); if (toast) dismiss(toast); return; }
    var toggle = t.closest('button[data-toggle-password]');
    if (toggle) {
      var input = document.getElementById(toggle.getAttribute('data-toggle-password'));
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Verbergen' : 'Tonen';
      return;
    }
    var gen = t.closest('button[data-generate-password]');
    if (gen) {
      var field = document.getElementById(gen.getAttribute('data-generate-password'));
      if (!field) return;
      var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
      var limit = 256 - (256 % chars.length);
      var out = '';
      while (out.length < 24) {
        var bytes = crypto.getRandomValues(new Uint8Array(32));
        for (var i = 0; i < bytes.length && out.length < 24; i++) {
          if (bytes[i] < limit) out += chars[bytes[i] % chars.length];
        }
      }
      field.value = out;
      field.type = 'text';
      var toggleBtn = document.querySelector('button[data-toggle-password="' + field.id + '"]');
      if (toggleBtn) toggleBtn.textContent = 'Verbergen';
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('input[data-select-all]')) return;
    var table = t.closest('table');
    if (!table) return;
    table.querySelectorAll('tbody input[type=checkbox][name="' + CSS.escape(t.getAttribute('data-select-all') || '') + '"]:not([disabled])')
      .forEach(function (box) { box.checked = t.checked; });
  });

  // Long actions: disable the button and show the fleet overlay until the next page loads.
  var overlay = document.querySelector('.busy-overlay');
  document.addEventListener('submit', function (e) {
    var btn = e.target.querySelector('button[data-busy]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = btn.getAttribute('data-busy');
    if (overlay) {
      overlay.querySelector('.busy-text').textContent = btn.getAttribute('data-busy');
      overlay.hidden = false;
    }
  });
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    if (overlay) overlay.hidden = true;
    document.querySelectorAll('button[data-busy][disabled]').forEach(function (b) { b.disabled = false; });
  });
})();
`;
