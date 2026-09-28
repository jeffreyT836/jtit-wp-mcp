import type { StoredSite } from '../../store/site-store.js';
import type { HealthInfo, HealthStatus, HealthTest } from '../../wp/site-health.js';
import type { HealthSnapshot } from '../health.js';
import { alert, panel, statusDot, subPanel } from './components.js';
import { html, type SafeHtml } from './html.js';
import { icon } from './icons.js';

const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '—';

const STATUS: Record<HealthStatus, { label: string; badge: string; dot: 'error' | 'warn' | 'ok' }> = {
  critical: { label: 'Kritiek', badge: 'error', dot: 'error' },
  recommended: { label: 'Aanbevolen', badge: 'warn', dot: 'warn' },
  good: { label: 'Geslaagd', badge: 'ok', dot: 'ok' },
};

/** Compact "3 kritiek · 2 aanbevolen" badges, used in the panel header, hero and overview. */
export function healthBadges(summary?: { critical: number; recommended: number; good: number }): SafeHtml | string {
  if (!summary) return '—';
  if (summary.critical === 0 && summary.recommended === 0) return html`<span class="badge ok">goed</span>`;
  return html`${summary.critical ? html`<span class="badge error">${String(summary.critical)} kritiek</span> ` : null}${summary.recommended ? html`<span class="badge warn">${String(summary.recommended)} aanbevolen</span>` : null}`;
}

function testItem(test: HealthTest): SafeHtml {
  const s = STATUS[test.status];
  const paragraphs = test.description.split('\n').filter(Boolean);
  // Only http(s) links reach this point (bridge + check here); rendered escaped.
  const links = test.actions.filter((a) => /^https?:\/\//i.test(a.url));
  return html`<details class="health-test">
  <summary>${statusDot(s.dot)}<span class="health-label">${test.label}</span>${test.badge.label ? html`<span class="tag">${test.badge.label}</span>` : null}${icon('chevron', 'icon chev')}</summary>
  <div class="health-body">
    ${paragraphs.map((p) => html`<p>${p}</p>`)}
    ${links.length ? html`<p class="health-links">${links.map((a) => html`<a href="${a.url}" rel="noopener noreferrer" target="_blank">${a.label} ${icon('external')}</a>`)}</p>` : null}
  </div>
</details>`;
}

const yesNo = (v?: boolean) => (v === undefined ? '—' : v ? 'ja' : 'nee');

function infoList(info: HealthInfo): SafeHtml {
  const rows: Array<[string, string | number | undefined]> = [
    ['WordPress', info.wp_version],
    ['PHP', info.php_version],
    ['Database', [info.db_server, info.db_version].filter(Boolean).join(' · ') || undefined],
    ['Geheugenlimiet PHP / WordPress', [info.memory_limit, info.wp_memory_limit].filter(Boolean).join(' / ') || undefined],
    ['Max. uitvoertijd', info.max_execution_time ? `${info.max_execution_time} s` : undefined],
    ['Max. upload / post', [info.upload_max_filesize, info.post_max_size].filter(Boolean).join(' / ') || undefined],
    ['HTTPS', yesNo(info.https)],
    ['Persistente object cache', yesNo(info.object_cache)],
    ['WP-Cron', info.wp_cron_disabled === undefined ? undefined : info.wp_cron_disabled ? 'uitgeschakeld (server-cron)' : 'actief'],
    ['Achterstallige cron-taken', info.cron_overdue],
    ['Omgeving', info.environment_type],
    ['Multisite', yesNo(info.multisite)],
    ['Taal / tijdzone', [info.language, info.timezone].filter(Boolean).join(' · ') || undefined],
    ['Thema', info.theme],
    ['Plugins actief / totaal / mu', info.plugins_total === undefined ? undefined : `${info.plugins_active ?? 0} / ${info.plugins_total} / ${info.mu_plugins ?? 0}`],
    ['Afbeeldingsbibliotheek', info.image_editor],
  ];
  const sizeLabels: Record<string, string> = {
    wordpress_size: 'WordPress-map', themes_size: "Thema's", plugins_size: 'Plugins', uploads_size: 'Uploads',
    fonts_size: 'Lettertypen', database_size: 'Database', total_size: 'Totaal',
  };
  const sizes = Object.entries(info.sizes ?? {}).filter(([, v]) => v.size);
  return html`<dl class="meta">
    ${rows.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}
    ${sizes.map(([k, v]) => html`<dt>Grootte: ${sizeLabels[k] ?? k}</dt><dd>${v.size}</dd>`)}
  </dl>`;
}

function refreshForm(csrf: string, siteId: string) {
  return html`<form method="post" action="/sites/${siteId}/health/refresh" class="inline">
    <input type="hidden" name="_csrf" value="${csrf}">
    <button type="submit" class="secondary" data-busy="Site Health controleren… (tot een minuut)">${icon('refresh')} Opnieuw controleren</button>
  </form>`;
}

/** "Site Health" panel on the site detail page. */
export function healthSection(opts: { csrf: string; site: StoredSite; snapshot?: HealthSnapshot }): SafeHtml {
  const { csrf, site, snapshot } = opts;
  const section = (body: SafeHtml, meta?: SafeHtml | string | null) =>
    panel({ id: 'health', title: 'Site Health', icon: 'shield', meta, body });
  if (!site.bridge) {
    return section(html`<div class="empty">${icon('info')}<span>Site Health vereist de nb-mcp-bridge; die staat uit voor deze site.</span></div>`);
  }
  const toolbar = (text: string) => html`<div class="toolbar"><p class="hint">${text}</p>${refreshForm(csrf, site.id)}</div>`;
  if (!snapshot) {
    return section(html`${toolbar('')}<div class="empty">${icon('shield')}<span>Nog geen Site Health-gegevens. Klik op "Opnieuw controleren" of wacht op de dagelijkse n8n-run.</span></div>`);
  }
  if (snapshot.error || !snapshot.data) {
    return section(html`${toolbar('')}${alert('error', `Site Health mislukt (${fmtDate(snapshot.collectedAt)}): ${snapshot.error}`)}`, html`<span class="badge error">fout</span>`);
  }
  const { tests, summary, info } = snapshot.data;
  const group = (status: HealthStatus, open: boolean) => {
    const items = tests.filter((t) => t.status === status);
    const tone = status === 'critical' ? 'error' : status === 'good' ? 'ok' : 'warn';
    return items.length ? subPanel(STATUS[status].label, items.length, html`${items.map(testItem)}`, open, tone) : null;
  };
  return section(
    html`${toolbar(`Gegevens van ${fmtDate(snapshot.collectedAt)}, zoals WP-admin → Gereedschap → Sitediagnose.`)}
    ${group('critical', true)}
    ${group('recommended', true)}
    ${group('good', false)}
    ${subPanel('Informatie', null, infoList(info), false)}`,
    healthBadges(summary),
  );
}
