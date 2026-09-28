import { html, type SafeHtml } from './html.js';
import { icon, type IconName } from './icons.js';

/**
 * Collapsible section. Native <details>, so it works without JavaScript; app.js remembers
 * the open/closed state per `id` and opens a panel when the URL hash points at it.
 */
export function panel(opts: {
  id: string;
  title: string | SafeHtml;
  icon?: IconName;
  meta?: string | SafeHtml | null;
  open?: boolean;
  tone?: 'danger';
  body: SafeHtml | SafeHtml[] | null;
}): SafeHtml {
  return html`<details class="panel${opts.tone ? ` panel-${opts.tone}` : ''}" id="${opts.id}" data-persist="${opts.id}" ${opts.open ? 'open' : ''}>
  <summary>
    ${opts.icon ? html`<span class="panel-icon">${icon(opts.icon)}</span>` : null}
    <span class="panel-title">${opts.title}</span>
    ${opts.meta ? html`<span class="panel-meta">${opts.meta}</span>` : null}
    ${icon('chevron', 'icon chev')}
  </summary>
  <div class="panel-body">${opts.body}</div>
</details>`;
}

/** Nested collapsible group inside a panel (e.g. "Plugins" within "Updates"). */
export function subPanel(title: string | SafeHtml, count: number | null, body: SafeHtml, open = true, tone: 'warn' | 'ok' | 'error' = 'warn'): SafeHtml {
  return html`<details class="sub" ${open ? 'open' : ''}>
  <summary><span>${title}</span>${count === null ? null : html`<span class="count ${tone}">${String(count)}</span>`}${icon('chevron', 'icon chev')}</summary>
  <div class="sub-body">${body}</div>
</details>`;
}

/** Page title row with optional subtitle and actions on the right. */
export function pageHead(title: string | SafeHtml, opts: { sub?: string | SafeHtml | null; actions?: SafeHtml | null; eyebrow?: string } = {}): SafeHtml {
  return html`<div class="page-head">
  <div>
    ${opts.eyebrow ? html`<p class="eyebrow">${opts.eyebrow}</p>` : null}
    <h1>${title}</h1>
    ${opts.sub ? html`<p class="sub">${opts.sub}</p>` : null}
  </div>
  ${opts.actions ? html`<div class="head-actions">${opts.actions}</div>` : null}
</div>`;
}

export type DotState = 'ok' | 'error' | 'warn' | 'unknown';

export const statusDot = (state: DotState, label?: string): SafeHtml =>
  html`<span class="dot ${state}" ${label ? html`title="${label}"` : null}></span>`;

/** Inline alert (form errors, warnings). */
export function alert(kind: 'error' | 'warn' | 'ok' | 'info', message: string | SafeHtml): SafeHtml {
  const name: IconName = kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert';
  return html`<div class="flash ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${icon(name)}<div>${message}</div></div>`;
}

/** Animated ring gauge (0–100). The ring fills on load via CSS. */
export function gauge(percent: number): SafeHtml {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return html`<svg class="gauge" viewBox="0 0 36 36" aria-hidden="true">
  <circle class="gauge-track" cx="18" cy="18" r="15.5" pathLength="100"/>
  <circle class="gauge-fill" cx="18" cy="18" r="15.5" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${String(100 - pct)}"/>
</svg>`;
}
