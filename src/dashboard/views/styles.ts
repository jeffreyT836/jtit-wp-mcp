/** Served at /assets/app.css. Kept in TS so `tsc` ships it without a copy step. */
export const APP_CSS = `
:root {
  --bg: #f6f7f9; --card: #fff; --text: #1d2330; --muted: #667085; --border: #e3e6eb;
  --accent: #2459d6; --ok: #127a3a; --ok-bg: #e5f5eb; --warn: #8a5a00; --warn-bg: #fff3d6;
  --err: #b42318; --err-bg: #fdecea;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151b; --card: #1b1f27; --text: #e7e9ee; --muted: #9aa3b2; --border: #2c323d;
    --accent: #7aa2ff; --ok: #6ee7a0; --ok-bg: #173323; --warn: #f5c56b; --warn-bg: #3a2e12;
    --err: #ff8a80; --err-bg: #3b1a1a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
a { color: var(--accent); }
.top { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between; padding: .75rem 1.25rem; background: var(--card); border-bottom: 1px solid var(--border); }
.brand { font-weight: 700; text-decoration: none; color: var(--text); }
nav { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; }
nav a { text-decoration: none; }
main { max-width: 1200px; margin: 1.5rem auto; padding: 0 1rem; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; }
.card.narrow { max-width: 420px; margin: 3rem auto; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; } h2 { font-size: 1.1rem; margin: 0 0 .75rem; }
h1 small { color: var(--muted); font-weight: 400; }
label { display: block; margin-bottom: .9rem; font-weight: 500; }
label small { color: var(--muted); font-weight: 400; }
input[type=text], input[type=email], input[type=password], input[type=url], input:not([type]) {
  display: block; width: 100%; margin-top: .3rem; padding: .55rem .7rem; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg); color: var(--text); font: inherit;
}
input[readonly] { opacity: .7; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0 1.25rem; }
fieldset.checks { border: 0; padding: 0; margin: 0 0 1rem; }
fieldset.checks label { font-weight: 400; margin-bottom: .4rem; }
button, .button { display: inline-block; padding: .55rem 1rem; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; font: inherit; cursor: pointer; text-decoration: none; }
button.secondary, .button.secondary { background: transparent; color: var(--accent); }
button.danger { background: var(--err); border-color: var(--err); }
button.link { background: none; border: 0; color: var(--accent); padding: 0; }
form.inline { display: inline-flex; gap: .5rem; align-items: center; margin: 0; }
label.confirm { display: inline; margin: 0; font-weight: 400; }
.actions { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; margin-top: 1rem; }
.flash { padding: .6rem .9rem; border-radius: 6px; }
.flash.ok { background: var(--ok-bg); color: var(--ok); } .flash.error { background: var(--err-bg); color: var(--err); }
.flash.warn { background: var(--warn-bg); color: var(--warn); }
fieldset.safe { border: 1px solid var(--border); border-radius: 8px; padding: .75rem 1rem; margin: 1.25rem 0 0; }
fieldset.safe small { display: block; margin-top: .35rem; }
textarea { display: block; width: 100%; margin-top: .3rem; padding: .55rem .7rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; min-height: 5rem; }
.hint { color: var(--muted); font-size: .9rem; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .55rem .6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); }
small { color: var(--muted); }
.badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .8rem; font-weight: 600; }
.badge.ok { background: var(--ok-bg); color: var(--ok); } .badge.warn { background: var(--warn-bg); color: var(--warn); }
.badge.error { background: var(--err-bg); color: var(--err); } .badge.muted { background: var(--border); color: var(--muted); }
.tag { display: inline-block; padding: 0 .4rem; border: 1px solid var(--border); border-radius: 4px; font-size: .75rem; color: var(--muted); }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .3rem 1.25rem; }
dl.meta dt { color: var(--muted); }
dl.meta dd { margin: 0; }
pre { background: var(--bg); padding: .75rem; border-radius: 6px; overflow-x: auto; font-size: .8rem; }
details { margin-bottom: .5rem; }
.qr { max-width: 220px; margin: 1rem auto; background: #fff; padding: .5rem; border-radius: 8px; }
.qr svg { width: 100%; height: auto; display: block; }
code.secret { word-break: break-all; }
label.warn { color: var(--warn); }
.section-head { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; justify-content: space-between; margin-bottom: .5rem; }
.section-head h2 { margin: 0; }
h3 { font-size: 1rem; margin: 1.25rem 0 .5rem; }
table.updates td.check, table.updates th.check { width: 2rem; }
table.updates label { display: inline; font-weight: 500; margin: 0; }
tr.major td { background: var(--warn-bg); }
small.warn { color: var(--warn); }
label.plain { font-weight: 400; }
.run { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border); }
button[disabled] { opacity: .6; cursor: progress; }
select { display: block; width: 100%; margin-top: .3rem; padding: .5rem .6rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; }
.password-field { display: flex; gap: .5rem; align-items: center; margin-top: .3rem; }
.password-field input { margin-top: 0; flex: 1; min-width: 0; font-family: ui-monospace, monospace; }
.password-field button { padding: .5rem .7rem; }
details.delete-user summary { cursor: pointer; color: var(--err); }
details.delete-user form { margin-top: .5rem; min-width: 220px; }
`;

/** Served at /assets/app.js (CSP allows only same-origin scripts). Progressive enhancement only. */
export const APP_JS = `
document.addEventListener('change', function (e) {
  var t = e.target;
  if (!t || !t.matches || !t.matches('input[data-select-all]')) return;
  var table = t.closest('table');
  if (!table) return;
  table.querySelectorAll('tbody input[type=checkbox][name="' + CSS.escape(t.getAttribute('data-select-all') || '') + '"]:not([disabled])')
    .forEach(function (box) { box.checked = t.checked; });
});
document.addEventListener('click', function (e) {
  var t = e.target;
  if (!t || !t.closest) return;
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
document.addEventListener('submit', function (e) {
  var btn = e.target.querySelector('button[data-busy]');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = btn.getAttribute('data-busy');
});
`;
