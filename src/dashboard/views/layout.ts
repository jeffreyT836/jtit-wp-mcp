import { statusDot, type DotState } from './components.js';
import { html, type SafeHtml } from './html.js';
import { icon, logo, logoMark, type IconName } from './icons.js';
import { ASSET_VERSION } from './assets.js';

export interface NavSite {
  id: string;
  name: string;
  state: DotState;
  updates: number;
}

export interface NavData {
  path: string;
  sites: NavSite[];
}

export interface LayoutOptions {
  title: string;
  body: SafeHtml;
  /** Logged-in user email; shows the sidebar when set. */
  user?: string;
  csrf?: string;
  nav?: NavData;
  flash?: { kind: 'ok' | 'error'; message: string };
}

function navLink(href: string, label: string, name: IconName, path: string, exact = true): SafeHtml {
  const active = exact ? path === href : path.startsWith(href);
  return html`<a class="nav-item${active ? ' active' : ''}" href="${href}" ${active ? html`aria-current="page"` : null}>${icon(name)}<span>${label}</span></a>`;
}

function siteLinks(nav: NavData): SafeHtml {
  if (nav.sites.length === 0) return html`<p class="nav-empty">Nog geen sites</p>`;
  return html`${nav.sites.map((site) => {
    const base = `/sites/${site.id}`;
    const active = nav.path === base || nav.path.startsWith(`${base}/`);
    return html`<a class="nav-site${active ? ' active' : ''}" href="${base}" ${active ? html`aria-current="page"` : null}>
        ${statusDot(site.state)}<span class="nav-site-name">${site.name}</span>
        ${site.updates > 0 ? html`<span class="nav-count" title="openstaande updates">${String(site.updates)}</span>` : null}
      </a>
      ${active
        ? html`<div class="nav-sub">
            <a href="${base}#updates">Updates</a>
            <a href="${base}/users" class="${nav.path === `${base}/users` ? 'active' : ''}">Gebruikers</a>
            <a href="${base}/edit" class="${nav.path === `${base}/edit` ? 'active' : ''}">Bewerken</a>
          </div>`
        : null}`;
  })}`;
}

function sidebar(user: string, csrf: string | undefined, nav: NavData): SafeHtml {
  return html`<aside class="sidebar" id="sidebar" aria-label="Navigatie">
  <div class="sidebar-top">
    <a class="brand" href="/" aria-label="WP Fleet — overzicht">${logo('side')}</a>
    <a class="nav-close" href="#" aria-label="Menu sluiten">${icon('x')}</a>
  </div>
  <nav>
    ${navLink('/', 'Overzicht', 'grid', nav.path)}
    ${navLink('/sites/new', 'Site toevoegen', 'plus', nav.path)}
    <p class="nav-label">Sites <span>${String(nav.sites.length)}</span></p>
    <div class="nav-sites">${siteLinks(nav)}</div>
    <p class="nav-label">Beheer</p>
    ${navLink('/audit', 'Audit-log', 'list', nav.path)}
    ${navLink('/settings', 'Instellingen', 'sliders', nav.path)}
  </nav>
  <div class="sidebar-foot">
    <span class="avatar" aria-hidden="true">${user.slice(0, 1).toUpperCase()}</span>
    <span class="who" title="${user}">${user}</span>
    <form method="post" action="/logout" class="inline">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit" class="icon-btn" title="Uitloggen" aria-label="Uitloggen">${icon('logout')}</button>
    </form>
  </div>
</aside>`;
}

/** Full-screen overlay shown by app.js while a long action (update run) is in progress. */
const busyOverlay = html`<div class="busy-overlay" hidden>
  <div class="busy-card">
    <div class="busy-logo">${logoMark('busy', 'logo-mark busy-mark')}
      <svg class="radar" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" pathLength="100"/></svg></div>
    <p class="busy-text" role="status" aria-live="polite">Bezig…</p>
    <div class="busy-bar"><span></span></div>
    <p class="hint">Sluit dit venster niet.</p>
  </div>
</div>`;

export function layout({ title, body, user, csrf, nav, flash }: LayoutOptions): string {
  const toast = flash
    ? html`<div class="toasts"><div class="toast ${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">
        ${icon(flash.kind === 'ok' ? 'check' : 'alert')}<p>${flash.message}</p>
        <button type="button" class="icon-btn" data-dismiss aria-label="Sluiten">${icon('x')}</button></div></div>`
    : null;
  const shell = user
    ? html`<div class="shell">
  ${sidebar(user, csrf, nav ?? { path: '', sites: [] })}
  <header class="mobilebar">
    <a class="icon-btn" href="#sidebar" aria-label="Menu openen">${icon('menu')}</a>
    <a class="brand" href="/">${logo('mobile')}</a>
  </header>
  <main class="content">${toast}${body}</main>
</div>`
    : html`<main class="auth">
  <a class="brand brand-lg" href="/">${logo('auth')}</a>
  ${toast}${body}
  <p class="auth-foot">WordPress fleet control · jtit</p>
</main>`;

  return html`<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${title} · WP Fleet</title>
<link rel="icon" type="image/svg+xml" href="/assets/logo.svg?v=${ASSET_VERSION}">
<link rel="stylesheet" href="/assets/app.css?v=${ASSET_VERSION}">
<script src="/assets/app.js?v=${ASSET_VERSION}" defer></script>
</head>
<body>
<div class="backdrop" aria-hidden="true"></div>
${shell}
${busyOverlay}
</body>
</html>`.value;
}
