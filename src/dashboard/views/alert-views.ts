import type { AlertRow } from '../db.js';
import { pageHead, panel, statusDot } from './components.js';
import { html, type SafeHtml } from './html.js';
import { icon } from './icons.js';

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '—';

const TYPE_LABEL: Record<string, string> = {
  unreachable: 'bereikbaarheid',
  not_admin: 'rechten',
  bridge_problem: 'bridge',
  health_critical: 'Site Health',
  vulnerable: 'kwetsbaarheid',
  new_admin: 'nieuwe admin',
  stale_data: 'n8n',
};

function detailText(alert: AlertRow): string | null {
  let d: Record<string, unknown>;
  try {
    d = alert.details ? (JSON.parse(alert.details) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
  switch (alert.type) {
    case 'unreachable':
      return typeof d.error === 'string' ? d.error : null;
    case 'vulnerable': {
      const names = Array.isArray(d.vulnerabilities) ? (d.vulnerabilities as unknown[]).map(String) : [];
      const fix = d.unfixed ? 'nog geen oplossing voor alles' : d.fixedIn ? `opgelost in ${String(d.fixedIn)}` : null;
      return [`${String(d.count ?? names.length)} kwetsbaarhe(i)d(en)`, fix, names.slice(0, 3).join('; ')].filter(Boolean).join(' · ');
    }
    case 'new_admin':
      return d.email ? `e-mail: ${String(d.email)} — niet herkend? Controleer de site direct.` : 'Niet herkend? Controleer de site direct.';
    case 'stale_data':
      return `Laatste data: ${fmtDate(typeof d.lastReceivedAt === 'string' ? d.lastReceivedAt : null)}. Controleer de n8n-workflow.`;
    default:
      return null;
  }
}

function ackForm(csrf: string, alert: AlertRow, back: string): SafeHtml | null {
  if (alert.status !== 'open') return null;
  const label = alert.state_kind === 'event' ? 'Gezien, afsluiten' : 'Gezien';
  return html`<form method="post" action="/alerts/${String(alert.id)}/ack" class="inline">
    <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="back" value="${back}">
    <button type="submit" class="secondary small">${icon('check')} ${label}</button>
  </form>`;
}

function alertTable(opts: { csrf: string; rows: AlertRow[]; siteName: (id: string | null) => SafeHtml | string; back: string; resolved?: boolean }): SafeHtml {
  const { csrf, rows, siteName, back, resolved } = opts;
  return html`<div class="table-wrap"><table>
    <thead><tr><th></th><th>Melding</th><th>Site</th><th>${resolved ? 'Periode' : 'Sinds'}</th><th></th></tr></thead>
    <tbody>${rows.map((a) => {
      const detail = detailText(a);
      const muted = a.status === 'acknowledged';
      return html`<tr class="${muted ? 'muted-row' : ''}">
        <td>${statusDot(resolved ? 'ok' : muted ? 'unknown' : a.severity === 'critical' ? 'error' : 'warn')}</td>
        <td><strong>${a.title}</strong> <span class="tag">${TYPE_LABEL[a.type] ?? a.type}</span>
          ${detail ? html`<br><small>${detail}</small>` : null}
          ${a.acknowledged_by ? html`<br><small>gezien door ${a.acknowledged_by} op ${fmtDate(a.acknowledged_at)}</small>` : null}</td>
        <td>${siteName(a.site_id)}</td>
        <td><small>${resolved ? html`${fmtDate(a.opened_at)} –<br>${fmtDate(a.resolved_at)}` : fmtDate(a.opened_at)}</small></td>
        <td>${resolved ? null : ackForm(csrf, a, back)}</td>
      </tr>`;
    })}</tbody></table></div>`;
}

/** `/alerts`: open and acknowledged alerts, plus recently resolved history. */
export function alertsPage(opts: {
  csrf: string;
  active: AlertRow[];
  resolved: AlertRow[];
  siteNames: Map<string, string>;
  webhookConfigured: boolean;
}): SafeHtml {
  const { csrf, active, resolved, siteNames, webhookConfigured } = opts;
  const siteName = (id: string | null) =>
    id ? html`<a href="/sites/${id}#alerts">${siteNames.get(id) ?? id}</a>` : html`<span class="tag">fleet</span>`;
  const open = active.filter((a) => a.status === 'open').length;
  return html`${pageHead('Meldingen', {
    eyebrow: 'Fleet',
    sub: webhookConfigured
      ? 'Nieuwe en opgeloste meldingen worden ook naar de ingestelde webhook gestuurd.'
      : 'Er is geen webhook ingesteld (ALERT_WEBHOOK_URL); meldingen zijn alleen hier te zien.',
  })}
${panel({
  id: 'alerts-active', title: 'Actief', icon: 'alert', open: true, meta: active.length ? `${open} nieuw · ${active.length - open} gezien` : null,
  body: active.length === 0
    ? html`<div class="empty">${icon('check')}<span>Geen actieve meldingen. Alles in orde.</span></div>`
    : alertTable({ csrf, rows: active, siteName, back: '/alerts' }),
})}
${panel({
  id: 'alerts-resolved', title: 'Opgelost', icon: 'clock', meta: resolved.length ? String(resolved.length) : null,
  body: resolved.length === 0
    ? html`<div class="empty">${icon('clock')}<span>Nog niets opgelost.</span></div>`
    : alertTable({ csrf, rows: resolved, siteName, back: '/alerts', resolved: true }),
})}`;
}

/** Site detail panel with the site's active alerts (hidden when there are none). */
export function siteAlertsSection(csrf: string, siteId: string, alerts: AlertRow[]): SafeHtml | null {
  const active = alerts.filter((a) => a.status === 'open' || a.status === 'acknowledged');
  if (active.length === 0) return null;
  const open = active.filter((a) => a.status === 'open');
  return panel({
    id: 'alerts', title: 'Meldingen', icon: 'alert', open: open.length > 0,
    meta: open.length ? html`<span class="badge error">${String(open.length)} nieuw</span>` : html`<span class="badge muted">${String(active.length)} gezien</span>`,
    body: alertTable({ csrf, rows: active, siteName: () => '', back: `/sites/${siteId}#alerts` }),
  });
}
