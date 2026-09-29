/**
 * Served at /assets/app.css. Kept in TS so `tsc` ships it without a copy step.
 * Brand: cyan #00FFED, ink #1D1D1B, pink #FF005E. The sidebar is always ink; the content
 * follows the system light/dark preference. CSP allows no inline styles, so all styling
 * lives here.
 */
export const APP_CSS = `
:root {
  --cyan: #00FFED; --ink: #1D1D1B; --pink: #FF005E;
  --bg: #F2F2EE; --surface: #FFFFFF; --surface-2: #F7F7F3; --border: #E3E3DC; --border-strong: #CFCFC6;
  --text: #1D1D1B; --muted: #6B6B64;
  --accent: #00A99D; --accent-soft: rgba(0,255,237,.16); --on-accent: #1D1D1B;
  --pink-text: #D6004F; --pink-soft: rgba(255,0,94,.09);
  --warn: #A86A00; --warn-soft: rgba(255,181,71,.2);
  --ok: #008C82; --ok-soft: rgba(0,255,237,.18);
  --shadow: 0 1px 2px rgba(29,29,27,.05), 0 8px 24px -12px rgba(29,29,27,.12);
  --radius: 14px; --sidebar-w: 268px;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
  interpolate-size: allow-keywords;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121211; --surface: #1D1D1B; --surface-2: #252523; --border: #2F2F2C; --border-strong: #42423E;
    --text: #F1F1EC; --muted: #9C9C94;
    --accent: #00FFED; --accent-soft: rgba(0,255,237,.1);
    --pink-text: #FF4D8A; --pink-soft: rgba(255,0,94,.14);
    --warn: #FFB547; --warn-soft: rgba(255,181,71,.13);
    --ok: #00FFED; --ok-soft: rgba(0,255,237,.1);
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 12px 32px -16px rgba(0,0,0,.6);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100vh; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-underline-offset: 3px; }
code, .mono { font-family: var(--mono); font-size: .88em; }
small, .hint { color: var(--muted); }
.hint { font-size: .88rem; margin: .25rem 0 1rem; }
h1 { font-size: 1.6rem; line-height: 1.2; letter-spacing: -.02em; margin: 0; font-weight: 750; }
h1 small { color: var(--muted); font-weight: 500; }
h2 { font-size: 1.05rem; margin: 0 0 .75rem; }
:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; border-radius: 6px; }
[hidden] { display: none !important; }
.icon { width: 18px; height: 18px; flex: none; }
.nav-close { width: 34px; height: 34px; place-items: center; border-radius: 9px; }

/* ---------- ambient backdrop ---------- */
.backdrop { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden;
  background-image: linear-gradient(to right, color-mix(in srgb, var(--text) 5%, transparent) 1px, transparent 1px),
    linear-gradient(to bottom, color-mix(in srgb, var(--text) 5%, transparent) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(ellipse 70% 60% at 70% 0%, #000 10%, transparent 75%); }
.backdrop::before, .backdrop::after { content: ""; position: absolute; width: 46vmax; height: 46vmax; border-radius: 50%; filter: blur(90px); opacity: .16; }
.backdrop::before { background: var(--cyan); top: -22vmax; right: -12vmax; animation: drift 22s ease-in-out infinite alternate; }
.backdrop::after { background: var(--pink); top: -8vmax; right: 18vmax; opacity: .09; animation: drift 28s ease-in-out infinite alternate-reverse; }
@keyframes drift { to { transform: translate(-8vmax, 6vmax) scale(1.15); } }

/* ---------- logo ---------- */
.brand { display: inline-flex; align-items: center; gap: .7rem; text-decoration: none; color: inherit; }
.logo-mark { width: 36px; height: 36px; flex: none; overflow: visible; }
.logo-mark .ship { transform-box: fill-box; transform-origin: center; animation: ship-in .8s cubic-bezier(.2,.9,.2,1) both, ship-float 3.6s ease-in-out infinite; }
.logo-mark .s1 { animation-delay: .05s, 1s; } .logo-mark .s2 { animation-delay: .18s, 1.3s; }
.logo-mark .s3 { animation-delay: .26s, 1.6s; } .logo-mark .s4 { animation-delay: .36s, 1.9s; }
@keyframes ship-in { from { opacity: 0; translate: 0 9px; } }
@keyframes ship-float { 50% { transform: translateY(-1.3px); } }
.brand:hover .logo-mark .ship { animation-duration: .8s, 1.1s; }
.wordmark { display: inline-flex; gap: .35em; font-weight: 800; letter-spacing: .16em; font-size: 1.02rem; }
.wm-wp { color: #F1F1EC; } .wm-fleet { color: var(--cyan); }
.brand-lg .logo-mark { width: 56px; height: 56px; } .brand-lg .wordmark { font-size: 1.5rem; }
.brand-lg .wm-wp { color: var(--text); } .brand-lg .wm-fleet { color: var(--accent); }

/* ---------- shell + sidebar ---------- */
.shell { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); min-height: 100vh; }
.sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; background: var(--ink); color: #CFCFC8; border-right: 1px solid #2C2C29; }
.sidebar-top { display: flex; align-items: center; justify-content: space-between; padding: 1.25rem 1.25rem 1rem; }
.nav-close { display: none; color: #CFCFC8; }
.sidebar nav { flex: 1; overflow-y: auto; padding: .25rem .75rem 1rem; scrollbar-width: thin; scrollbar-color: #3A3A36 transparent; }
.nav-item, .nav-site { position: relative; display: flex; align-items: center; gap: .7rem; padding: .55rem .75rem; border-radius: 10px; color: #CFCFC8; text-decoration: none; font-weight: 500; transition: background .15s, color .15s; }
.nav-item .icon { width: 18px; height: 18px; opacity: .8; }
.nav-item:hover, .nav-site:hover { background: rgba(255,255,255,.05); color: #fff; }
.nav-item.active, .nav-site.active { background: linear-gradient(90deg, rgba(0,255,237,.13), rgba(0,255,237,.02)); color: #fff; }
.nav-item.active::before, .nav-site.active::before { content: ""; position: absolute; left: -.75rem; top: 20%; bottom: 20%; width: 3px; border-radius: 0 3px 3px 0; background: var(--cyan); box-shadow: 0 0 12px var(--cyan); }
.nav-item.active .icon { color: var(--cyan); opacity: 1; }
.nav-label { display: flex; justify-content: space-between; margin: 1.4rem .75rem .45rem; font-size: .7rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #7E7E77; }
.nav-label span { color: #5E5E58; }
.nav-site { font-size: .92rem; padding: .45rem .75rem; }
.nav-site-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-count { font-size: .72rem; font-weight: 700; padding: .05rem .45rem; border-radius: 999px; background: rgba(255,181,71,.16); color: #FFB547; }
.nav-item .nav-count { margin-left: auto; } .nav-count.alert { background: rgba(255,0,94,.2); color: #FF6FA0; }
.nav-sub { display: grid; margin: .1rem 0 .4rem 1.55rem; padding-left: .75rem; border-left: 1px solid #34342F; }
.nav-sub a { padding: .3rem .5rem; font-size: .86rem; color: #9C9C94; text-decoration: none; border-radius: 6px; }
.nav-sub a:hover, .nav-sub a.active { color: var(--cyan); }
.nav-empty { margin: 0 .75rem; font-size: .88rem; color: #7E7E77; }
.sidebar-foot { display: flex; align-items: center; gap: .6rem; padding: .9rem 1rem; border-top: 1px solid #2C2C29; }
.avatar { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: 50%; font-weight: 800; color: var(--ink); background: linear-gradient(135deg, var(--cyan), #7AFFF5); }
.who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .85rem; color: #9C9C94; }
.icon-btn { display: inline-grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 9px; background: transparent; color: inherit; cursor: pointer; }
.icon-btn:hover { background: rgba(127,127,127,.15); }
.icon-btn .icon { width: 18px; height: 18px; }
.mobilebar { display: none; }
.content { padding: 2rem clamp(1rem, 3vw, 2.5rem) 4rem; max-width: 1240px; width: 100%; }

@media (max-width: 900px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .sidebar { position: fixed; inset: 0 auto 0 0; width: min(86vw, 300px); z-index: 40; transform: translateX(-102%); transition: transform .3s cubic-bezier(.2,.8,.2,1); box-shadow: 20px 0 60px rgba(0,0,0,.4); }
  .sidebar:target { transform: none; }
  .nav-close { display: inline-grid; }
  .mobilebar { display: flex; align-items: center; gap: .5rem; position: sticky; top: 0; z-index: 30; padding: .6rem 1rem; background: var(--ink); color: #F1F1EC; }
  .mobilebar .logo-mark { width: 30px; height: 30px; }
  .content { padding-top: 1.25rem; }
}

/* ---------- page head ---------- */
.page-head { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; justify-content: space-between; margin-bottom: 1.5rem; }
.page-head .sub { margin: .35rem 0 0; color: var(--muted); }
.eyebrow { margin: 0 0 .35rem; font-size: .72rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
.head-actions { display: flex; flex-wrap: wrap; gap: .6rem; }

/* ---------- cards & panels ---------- */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.4rem 1.5rem; margin-bottom: 1.25rem; box-shadow: var(--shadow); animation: rise .45s cubic-bezier(.2,.8,.2,1) both; }
.card.narrow { width: min(440px, 100%); margin: 0 auto 1.25rem; }
.card > h2:first-child { margin-top: 0; }
@keyframes rise { from { opacity: 0; translate: 0 10px; } }

details.panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 1rem; box-shadow: var(--shadow); overflow: hidden; animation: rise .45s cubic-bezier(.2,.8,.2,1) both; }
.content > :nth-child(2) { animation-delay: .04s; } .content > :nth-child(3) { animation-delay: .08s; }
.content > :nth-child(4) { animation-delay: .12s; } .content > :nth-child(5) { animation-delay: .16s; }
.content > :nth-child(6) { animation-delay: .2s; } .content > :nth-child(7) { animation-delay: .24s; }
details.panel > summary { display: flex; align-items: center; gap: .75rem; padding: 1rem 1.25rem; cursor: pointer; list-style: none; user-select: none; transition: background .15s; }
details > summary::-webkit-details-marker { display: none; }
details.panel > summary:hover { background: var(--surface-2); }
.panel-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); flex: none; }
.panel-icon .icon { width: 18px; height: 18px; }
.panel-title { font-weight: 700; font-size: 1.02rem; }
.panel-meta { color: var(--muted); font-size: .88rem; }
.chev { width: 18px; height: 18px; margin-left: auto; color: var(--muted); transition: rotate .3s cubic-bezier(.2,.8,.2,1); flex: none; }
details[open] > summary > .chev { rotate: 180deg; }
details.panel[open] > summary { border-bottom: 1px solid var(--border); }
.panel-body { padding: 1.25rem; }
details::details-content { block-size: 0; overflow-y: clip; transition: block-size .35s cubic-bezier(.2,.8,.2,1), content-visibility .35s allow-discrete; }
details[open]::details-content { block-size: auto; }
details[open] > .panel-body, details[open] > .sub-body { animation: fade .35s ease both; }
@keyframes fade { from { opacity: 0; } }
.panel-danger .panel-icon { background: var(--pink-soft); color: var(--pink-text); }

details.sub { border: 1px solid var(--border); border-radius: 12px; margin-bottom: .85rem; background: var(--surface-2); }
details.sub > summary { display: flex; align-items: center; gap: .6rem; padding: .7rem 1rem; cursor: pointer; list-style: none; font-weight: 650; }
details.sub .count { font-size: .75rem; font-weight: 700; padding: .05rem .5rem; border-radius: 999px; background: var(--warn-soft); color: var(--warn); }
details.sub .count.ok { background: var(--ok-soft); color: var(--ok); } details.sub .count.error { background: var(--pink-soft); color: var(--pink-text); }
details.health-test { border-top: 1px solid var(--border); background: var(--surface); }
details.health-test:first-child { border-top: 0; border-radius: 9px 9px 0 0; } details.health-test:last-child { border-radius: 0 0 9px 9px; }
details.health-test > summary { display: flex; align-items: center; gap: .65rem; padding: .7rem .9rem; cursor: pointer; list-style: none; }
details.health-test > summary:hover { background: var(--surface-2); }
.health-label { font-weight: 600; }
.health-body { padding: 0 .9rem .9rem 2.2rem; color: var(--muted); font-size: .92rem; }
.health-body p { margin: 0 0 .5rem; }
.health-links { display: flex; flex-wrap: wrap; gap: .5rem 1rem; }
.health-links a { display: inline-flex; align-items: center; gap: .3rem; }
.health-links .icon { width: 14px; height: 14px; }
.chip .badge { font-size: .72rem; }
.sub-body { padding: 0 .5rem .5rem; }
.sub-body table { background: var(--surface); border-radius: 9px; }

/* ---------- hero (site header) ---------- */
.hero { position: relative; border: 1px solid transparent; border-radius: 18px; padding: 1.6rem 1.75rem; margin-bottom: 1.25rem; overflow: hidden; box-shadow: var(--shadow);
  background: linear-gradient(var(--surface), var(--surface)) padding-box, linear-gradient(120deg, var(--cyan), transparent 35%, transparent 65%, var(--pink)) border-box; animation: rise .45s cubic-bezier(.2,.8,.2,1) both; }
.hero::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .3s;
  background: radial-gradient(420px circle at var(--mx, 50%) var(--my, 0%), rgba(0,255,237,.09), transparent 60%); }
.hero:hover::before { opacity: 1; }
.hero-title { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
.hero-url { display: inline-flex; align-items: center; gap: .35rem; margin-top: .4rem; font-size: .95rem; }
.hero-url .icon { width: 14px; height: 14px; }
.chips { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1.1rem 0 1.25rem; }
.chip { display: inline-flex; align-items: baseline; gap: .4rem; padding: .35rem .75rem; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); font-size: .85rem; }
.chip b { font-family: var(--mono); font-weight: 600; }
.chip small { font-size: .78rem; }
.actions { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }

/* ---------- stat tiles ---------- */
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; margin-bottom: 1.25rem; }
@media (max-width: 1200px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 520px) { .tiles { grid-template-columns: minmax(0, 1fr); } }
.tile { position: relative; display: flex; align-items: center; gap: 1rem; padding: 1.15rem 1.25rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; animation: rise .5s cubic-bezier(.2,.8,.2,1) both; }
.tile:nth-child(2) { animation-delay: .06s; } .tile:nth-child(3) { animation-delay: .12s; } .tile:nth-child(4) { animation-delay: .18s; }
.tile::after { content: ""; position: absolute; right: -30px; top: -30px; width: 90px; height: 90px; border-radius: 50%; background: var(--tile-glow, var(--accent-soft)); filter: blur(10px); }
.tile.warn { --tile-glow: var(--warn-soft); } .tile.error { --tile-glow: var(--pink-soft); }
.tile-num { font-size: 2rem; font-weight: 800; letter-spacing: -.03em; line-height: 1; font-variant-numeric: tabular-nums; }
.tile-label { font-size: .78rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: .35rem; }
.tile.warn .tile-num { color: var(--warn); } .tile.error .tile-num { color: var(--pink-text); }
.gauge { width: 52px; height: 52px; rotate: -90deg; flex: none; }
.gauge circle { fill: none; stroke-width: 3.5; }
.gauge-track { stroke: var(--border); }
.gauge-fill { stroke: var(--accent); stroke-linecap: round; animation: gauge 1.4s cubic-bezier(.2,.8,.2,1) .2s both; filter: drop-shadow(0 0 4px rgba(0,255,237,.5)); }
@keyframes gauge { from { stroke-dashoffset: 100; } }

/* ---------- forms ---------- */
label { display: block; margin-bottom: 1rem; font-weight: 600; font-size: .92rem; }
label small { font-weight: 400; }
input[type=text], input[type=email], input[type=password], input[type=url], input:not([type]), select, textarea {
  display: block; width: 100%; margin-top: .35rem; padding: .62rem .8rem; border: 1px solid var(--border-strong); border-radius: 10px;
  background: var(--surface-2); color: var(--text); font: inherit; font-weight: 400; transition: border-color .15s, box-shadow .15s, background .15s; }
input:hover, select:hover, textarea:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-strong)); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); background: var(--surface); }
input[readonly] { opacity: .65; }
textarea { min-height: 5.5rem; resize: vertical; }
input[type=checkbox] { width: 1.05rem; height: 1.05rem; accent-color: #00D6C7; vertical-align: -.15em; margin: 0 .4rem 0 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0 1.25rem; }
.form-section { padding-top: 1.1rem; margin-top: .25rem; border-top: 1px solid var(--border); }
.form-section h2 { font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
fieldset.checks { border: 0; padding: 0; margin: 0 0 1rem; display: grid; gap: .5rem; }
fieldset.checks label, label.plain { font-weight: 400; margin: 0; }
label.warn { color: var(--warn); }
label.confirm { display: inline-flex; align-items: center; margin: 0; font-weight: 500; }
.password-field { display: flex; gap: .5rem; align-items: center; margin-top: .35rem; }
.password-field input { margin-top: 0; flex: 1; min-width: 0; font-family: var(--mono); }
.form-foot { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; margin-top: 1.25rem; }

/* ---------- buttons ---------- */
button, .button { display: inline-flex; align-items: center; justify-content: center; gap: .45rem; padding: .6rem 1.05rem; border-radius: 10px; border: 1px solid transparent;
  background: var(--cyan); color: var(--on-accent); font: inherit; font-weight: 650; cursor: pointer; text-decoration: none; white-space: nowrap;
  transition: transform .15s, box-shadow .2s, background .15s, border-color .15s, color .15s; }
button .icon, .button .icon { width: 17px; height: 17px; }
button:hover, .button:hover { transform: translateY(-1px); box-shadow: 0 6px 20px -6px rgba(0,255,237,.7); }
button:active, .button:active { transform: none; }
button.secondary, .button.secondary { background: transparent; color: var(--text); border-color: var(--border-strong); }
button.secondary:hover, .button.secondary:hover { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
button.danger, .button.danger { background: var(--pink); color: #fff; }
button.danger:hover { box-shadow: 0 6px 20px -6px rgba(255,0,94,.7); }
button.link { background: none; border: 0; color: var(--accent); padding: 0; }
button.small, .button.small { padding: .3rem .7rem; font-size: .8rem; }
tr.muted-row td { opacity: .6; }
button[disabled] { opacity: .6; cursor: progress; transform: none; box-shadow: none; }
.icon-btn:hover { transform: none; box-shadow: none; }
form.inline { display: inline-flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin: 0; }

/* ---------- alerts & toasts ---------- */
.flash { display: flex; gap: .7rem; align-items: flex-start; padding: .8rem 1rem; border-radius: 12px; margin: 0 0 1rem; border: 1px solid transparent; font-size: .93rem; }
.flash .icon { width: 18px; height: 18px; flex: none; margin-top: .12rem; }
.flash > div { min-width: 0; overflow-wrap: anywhere; }
.flash.ok { background: var(--ok-soft); color: var(--ok); border-color: color-mix(in srgb, var(--ok) 25%, transparent); }
.flash.error { background: var(--pink-soft); color: var(--pink-text); border-color: color-mix(in srgb, var(--pink) 25%, transparent); }
.flash.warn { background: var(--warn-soft); color: var(--warn); border-color: color-mix(in srgb, var(--warn) 25%, transparent); }
.flash.info { background: var(--surface-2); color: var(--muted); border-color: var(--border); }
.toasts { position: fixed; top: 1rem; right: 1rem; z-index: 60; width: min(420px, calc(100vw - 2rem)); }
.toast { display: flex; gap: .7rem; align-items: flex-start; padding: .85rem .9rem .85rem 1rem; border-radius: 14px; background: var(--ink); color: #F1F1EC; box-shadow: 0 18px 50px -12px rgba(0,0,0,.5); border: 1px solid #34342F; animation: toast-in .5s cubic-bezier(.2,.9,.2,1.15) both; }
.toast p { margin: 0; flex: 1; overflow-wrap: anywhere; }
.toast > .icon { width: 20px; height: 20px; flex: none; margin-top: .1rem; }
.toast.ok > .icon { color: var(--cyan); } .toast.error > .icon { color: var(--pink); }
.toast.ok { border-left: 3px solid var(--cyan); } .toast.error { border-left: 3px solid var(--pink); }
.toast .icon-btn { width: 28px; height: 28px; color: #9C9C94; }
.toast.hide { animation: toast-out .4s ease forwards; }
@keyframes toast-in { from { opacity: 0; transform: translate(30px, -6px) scale(.97); } }
@keyframes toast-out { to { opacity: 0; transform: translateX(30px); } }

/* ---------- tables ---------- */
.table-wrap { overflow-x: auto; margin: 0 -.25rem; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .7rem .75rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); }
tbody tr { transition: background .15s; animation: row-in .4s ease both; }
tbody tr:hover { background: var(--surface-2); }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:nth-child(2) { animation-delay: .03s; } tbody tr:nth-child(3) { animation-delay: .06s; } tbody tr:nth-child(4) { animation-delay: .09s; }
tbody tr:nth-child(5) { animation-delay: .12s; } tbody tr:nth-child(6) { animation-delay: .15s; } tbody tr:nth-child(n+7) { animation-delay: .18s; }
@keyframes row-in { from { opacity: 0; translate: -6px 0; } }
td code { color: var(--muted); }
.site-cell a { font-weight: 700; color: var(--text); text-decoration: none; }
.site-cell a:hover { color: var(--accent); }
table.updates td.check, table.updates th.check { width: 2.5rem; }
table.updates label { display: inline; font-weight: 600; margin: 0; }
.version { font-family: var(--mono); font-size: .85rem; white-space: nowrap; }
.version .arrow { color: var(--accent); margin: 0 .3rem; }
tr.major td { background: var(--warn-soft); }
small.warn { color: var(--warn); }

/* ---------- badges, dots, tags ---------- */
.badge { display: inline-flex; align-items: center; gap: .35rem; padding: .16rem .6rem; border-radius: 999px; font-size: .76rem; font-weight: 700; white-space: nowrap; }
.badge.ok { background: var(--ok-soft); color: var(--ok); } .badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.error { background: var(--pink-soft); color: var(--pink-text); } .badge.muted { background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); }
.badge.role-admin { background: var(--pink-soft); color: var(--pink-text); }
.tag { display: inline-block; white-space: nowrap; padding: .05rem .5rem; border: 1px solid var(--border); border-radius: 6px; font-size: .74rem; color: var(--muted); margin: .15rem .15rem 0 0; }
.dot { position: relative; display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #6B6B64; flex: none; }
.dot.ok { background: var(--cyan); box-shadow: 0 0 8px rgba(0,255,237,.7); }
.dot.error { background: var(--pink); box-shadow: 0 0 8px rgba(255,0,94,.7); }
.dot.warn { background: #FFB547; }
.dot.ok::after, .dot.error::after { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 2px solid currentColor; animation: ping 2.4s cubic-bezier(0,0,.2,1) infinite; }
.dot.ok::after { color: var(--cyan); } .dot.error::after { color: var(--pink); animation-duration: 1.4s; }
@keyframes ping { 75%, 100% { transform: scale(2.6); opacity: 0; } }

/* ---------- misc ---------- */
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1.5rem; margin: 0; }
dl.meta dt { color: var(--muted); font-size: .9rem; }
dl.meta dd { margin: 0; }
pre { background: var(--surface-2); border: 1px solid var(--border); padding: .9rem; border-radius: 10px; overflow-x: auto; font: .8rem/1.5 var(--mono); }
details.raw { margin-bottom: .5rem; }
details.raw > summary { cursor: pointer; padding: .35rem 0; }
.qr { max-width: 220px; margin: 1rem auto; background: #fff; padding: .6rem; border-radius: 12px; box-shadow: 0 0 0 4px var(--accent-soft); }
.qr svg { width: 100%; height: auto; display: block; }
code.secret { word-break: break-all; }
fieldset.safe { border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); background: var(--accent-soft); border-radius: 12px; padding: .9rem 1rem; margin: 1rem 0 0; }
fieldset.safe label { display: flex; align-items: center; gap: .3rem; }
fieldset.safe .icon { width: 18px; height: 18px; color: var(--accent); }
fieldset.safe small { display: block; margin-top: .4rem; }
.run { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between; margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.toolbar { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
.toolbar .hint { margin: 0; }
.empty { display: flex; gap: .75rem; align-items: center; padding: 1rem; border: 1px dashed var(--border-strong); border-radius: 12px; color: var(--muted); }
.empty .icon { width: 22px; height: 22px; color: var(--accent); }
td.row-actions { text-align: right; width: 1%; white-space: nowrap; vertical-align: top; }
details.delete-user > summary { list-style: none; cursor: pointer; color: var(--pink-text); font-weight: 600; font-size: .88rem; display: inline-flex; gap: .3rem; align-items: center; }
details.delete-user > summary .icon { width: 15px; height: 15px; }
details.delete-user form { width: 260px; margin-top: .6rem; text-align: left; white-space: normal; padding: .9rem; border-radius: 12px; background: var(--surface-2); border: 1px solid color-mix(in srgb, var(--pink) 30%, var(--border)); animation: rise .25s ease both; }
details.delete-user label.confirm { margin: .25rem 0 .85rem; }
.result-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; margin: 0 0 1.25rem; }
.auth { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.75rem; padding: 2rem 1rem; }
.auth .card { padding: 1.75rem; }
.auth .card h1 { font-size: 1.35rem; margin-bottom: 1rem; }
.auth button[type=submit] { width: 100%; margin-top: .25rem; }
.auth-foot { color: var(--muted); font-size: .8rem; letter-spacing: .08em; }

/* ---------- busy overlay ---------- */
.busy-overlay { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: rgba(18,18,17,.72); backdrop-filter: blur(6px); animation: fade .3s ease both; }
.busy-card { width: min(380px, 90vw); text-align: center; padding: 2rem 1.75rem 1.5rem; border-radius: 20px; background: var(--ink); color: #F1F1EC; border: 1px solid #34342F; box-shadow: 0 30px 80px -20px rgba(0,0,0,.7); }
.busy-logo { position: relative; width: 120px; height: 120px; margin: 0 auto 1.25rem; display: grid; place-items: center; }
.busy-mark { width: 64px; height: 64px; }
.busy-mark .ship { animation: ship-in .8s cubic-bezier(.2,.9,.2,1) both, thrust 1.1s ease-in-out infinite; }
@keyframes thrust { 50% { transform: translateY(-3px); } }
.radar { position: absolute; inset: 0; width: 100%; height: 100%; animation: spin 1.6s linear infinite; }
.radar circle { fill: none; stroke: var(--cyan); stroke-width: 2; stroke-linecap: round; stroke-dasharray: 22 78; filter: drop-shadow(0 0 6px var(--cyan)); }
@keyframes spin { to { rotate: 360deg; } }
.busy-text { font-weight: 650; margin: 0 0 1rem; }
.busy-bar { height: 4px; border-radius: 4px; background: #2F2F2C; overflow: hidden; }
.busy-bar span { display: block; height: 100%; width: 40%; border-radius: 4px; background: linear-gradient(90deg, var(--cyan), var(--pink)); animation: slide 1.4s ease-in-out infinite; }
@keyframes slide { from { translate: -100% 0; } to { translate: 250% 0; } }
.busy-card .hint { color: #7E7E77; margin: 1rem 0 0; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
  .backdrop::before, .backdrop::after { animation: none; }
}
@media (max-width: 600px) {
  h1 { font-size: 1.35rem; }
  .hero { padding: 1.25rem; }
  .panel-body { padding: 1rem; }
  dl.meta { grid-template-columns: 1fr; gap: .1rem; } dl.meta dd { margin-bottom: .5rem; }
}
`;
