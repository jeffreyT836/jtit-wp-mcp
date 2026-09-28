import type { StoredSite } from '../../store/site-store.js';
import type { NetworkOverview, NetworkSite, NetworkSiteDetail } from '../../wp/network.js';
import { alert, pageHead, panel } from './components.js';
import { html, type SafeHtml } from './html.js';
import { icon } from './icons.js';

const fmtDate = (value?: string) => {
  if (!value || value.startsWith('0000')) return '—';
  const d = new Date(value.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' });
};

const external = (url: string) =>
  /^https?:\/\//i.test(url) ? html`<a href="${url}" rel="noopener noreferrer" target="_blank">${url} ${icon('external')}</a>` : html`${url}`;

function flags(site: NetworkSite): SafeHtml {
  return html`${site.is_main ? html`<span class="badge ok">hoofdsite</span> ` : null}${site.archived ? html`<span class="badge warn">gearchiveerd</span> ` : null}${site.deleted ? html`<span class="badge error">gedeactiveerd</span> ` : null}${site.spam ? html`<span class="badge error">spam</span> ` : null}${!site.public ? html`<span class="badge muted">niet openbaar</span>` : null}`;
}

export function networkPage(opts: { site: StoredSite; overview?: NetworkOverview; error?: string }): SafeHtml {
  const { site, overview, error } = opts;
  const head = pageHead(html`Multisite: ${site.name}`, {
    eyebrow: site.id,
    sub: overview?.network ? `Netwerk: ${overview.network.name || overview.network.domain} · live opgehaald uit WordPress` : 'Live opgehaald uit WordPress.',
    actions: html`<a class="button secondary" href="/sites/${site.id}">Terug naar de site</a>`,
  });
  if (error) return html`${head}${alert('error', error)}`;
  if (!overview?.multisite) return html`${head}${alert('info', 'Deze site is geen multisite.')}`;
  const more = overview.total > overview.sites.length
    ? alert('info', `De eerste ${overview.sites.length} van ${overview.total} sites worden getoond.`)
    : null;
  return html`${head}${more}
${panel({
  id: 'network-sites', title: 'Sites in het netwerk', icon: 'globe', meta: `(${overview.total})`, open: true,
  body: html`<div class="table-wrap"><table>
    <thead><tr><th>Site</th><th>Status</th><th>Aangemaakt</th><th>Laatst gewijzigd</th></tr></thead>
    <tbody>${overview.sites.map(
      (s) => html`<tr>
        <td class="site-cell"><a href="/sites/${site.id}/network/${String(s.blog_id)}">${s.name || s.domain + s.path}</a><br><small>${s.url}</small></td>
        <td>${flags(s)}</td>
        <td><small>${fmtDate(s.registered)}</small></td>
        <td><small>${fmtDate(s.last_updated)}</small></td>
      </tr>`,
    )}</tbody></table></div>`,
})}`;
}

export function networkSitePage(opts: { site: StoredSite; blogId: number; detail?: NetworkSiteDetail; error?: string }): SafeHtml {
  const { site, blogId, detail, error } = opts;
  const back = html`<a class="button secondary" href="/sites/${site.id}/network">Alle sites in het netwerk</a>`;
  if (error || !detail) {
    return html`${pageHead(`Subsite ${blogId}`, { eyebrow: site.id, actions: back })}${alert('error', error ?? 'Subsite niet gevonden.')}`;
  }
  const plugins = [...detail.plugins].sort((a, b) => a.name.localeCompare(b.name));
  return html`
<section class="hero">
  <p class="eyebrow">${site.name} · subsite ${String(blogId)}</p>
  <div class="hero-title"><h1>${detail.name}</h1>${flags(detail)}</div>
  <span class="hero-url">${external(detail.url)}</span>
  <div class="chips">
    <span class="chip"><small>Berichten</small><b>${String(detail.counts.posts)}</b></span>
    <span class="chip"><small>Pagina's</small><b>${String(detail.counts.pages)}</b></span>
    <span class="chip"><small>Gebruikers</small><b>${String(detail.counts.users)}</b></span>
    <span class="chip"><small>Thema</small><b>${detail.theme.name} ${detail.theme.version}</b></span>
  </div>
  <div class="actions">
    <a class="button" href="/sites/${site.id}/network/${String(blogId)}/users">${icon('users')} Gebruikers</a>
    ${/^https?:\/\//i.test(detail.url) ? html`<a class="button secondary" href="${detail.url.replace(/\/?$/, '/')}wp-admin/" rel="noopener noreferrer" target="_blank">${icon('external')} WP-admin</a>` : null}
    ${back}
  </div>
</section>
${panel({
  id: 'subsite-info', title: 'Overzicht', icon: 'info', open: true,
  body: html`<dl class="meta">
    <dt>Blog-id</dt><dd><code>${String(detail.blog_id)}</code></dd>
    <dt>Adres</dt><dd>${detail.domain}${detail.path}</dd>
    <dt>Beheerder-e-mail</dt><dd>${detail.admin_email || '—'}</dd>
    <dt>Taal</dt><dd>${detail.language || '—'}</dd>
    <dt>Thema</dt><dd>${detail.theme.name} ${detail.theme.version} <small>(${detail.theme.stylesheet})</small></dd>
    <dt>Aangemaakt</dt><dd>${fmtDate(detail.registered)}</dd>
    <dt>Laatst gewijzigd</dt><dd>${fmtDate(detail.last_updated)}</dd>
  </dl>`,
})}
${panel({
  id: 'subsite-plugins', title: 'Actieve plugins', icon: 'plug', meta: `(${plugins.length})`,
  body: plugins.length === 0
    ? html`<div class="empty">${icon('plug')}<span>Geen actieve plugins.</span></div>`
    : html`<div class="table-wrap"><table>
        <thead><tr><th>Plugin</th><th>Versie</th><th>Activering</th></tr></thead>
        <tbody>${plugins.map((p) => html`<tr>
          <td><strong>${p.name}</strong><br><small>${p.plugin}</small></td>
          <td class="version">${p.version || '—'}</td>
          <td>${p.network ? html`<span class="badge muted">netwerkbreed</span>` : html`<span class="badge ok">deze site</span>`}</td>
        </tr>`)}</tbody></table></div>
      <p class="hint">Updates van plugins, thema's en WordPress gelden voor het hele netwerk; die voer je uit op de hoofdsite.</p>`,
})}`;
}
