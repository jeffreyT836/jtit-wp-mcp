import type { StoredSite } from '../../store/site-store.js';
import type { AuditRow, SnapshotRow } from '../db.js';
import type { SiteStatus } from '../snapshots.js';
import { alert, gauge, pageHead, panel, statusDot } from './components.js';
import { html, type SafeHtml } from './html.js';
import { icon } from './icons.js';

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '—';

function statusBadge(site: StoredSite, status: SiteStatus) {
  if (!site.hasPassword) return html`<span class="badge error">${statusDot('error')} geen wachtwoord</span>`;
  if (status.reachable === undefined) return html`<span class="badge muted">${statusDot('unknown')} nog geen data</span>`;
  return status.reachable
    ? html`<span class="badge ok">${statusDot('ok')} bereikbaar</span>`
    : html`<span class="badge error" title="${status.error ?? ''}">${statusDot('error')} fout</span>`;
}

const pendingUpdates = (status: SiteStatus) =>
  status.updates ? status.updates.core + status.updates.plugins + status.updates.themes : 0;

function updatesCell(status: SiteStatus) {
  if (status.updatesError) return html`<span class="badge warn" title="${status.updatesError}">fout</span>`;
  if (!status.updates) return '—';
  const { core, plugins, themes } = status.updates;
  const total = core + plugins + themes;
  return total === 0
    ? html`<span class="badge ok">up-to-date</span>`
    : html`<span class="badge warn">${String(total)} open</span><br><small>core ${String(core)} · plugins ${String(plugins)} · thema's ${String(themes)}</small>`;
}

function tile(label: string, value: number, opts: { tone?: 'warn' | 'error'; sub?: string; gaugePct?: number } = {}) {
  return html`<div class="tile ${opts.tone ?? ''}">
    ${opts.gaugePct === undefined ? null : gauge(opts.gaugePct)}
    <div><div class="tile-label">${label}</div>
      <div class="tile-num" data-count="${String(value)}">${String(value)}</div>
      ${opts.sub ? html`<small>${opts.sub}</small>` : null}</div>
  </div>`;
}

export function overviewPage(rows: { site: StoredSite; status: SiteStatus }[]) {
  const addButton = html`<a class="button" href="/sites/new">${icon('plus')} Site toevoegen</a>`;
  if (rows.length === 0) {
    return html`${pageHead('Overzicht', { eyebrow: 'Fleet', actions: addButton })}
<section class="card"><div class="empty">${icon('globe')}<span>Nog geen sites. <a href="/sites/new">Voeg je eerste site toe</a> om te beginnen.</span></div></section>`;
  }
  const reachable = rows.filter((r) => r.status.reachable).length;
  const updates = rows.reduce((sum, r) => sum + pendingUpdates(r.status), 0);
  const problems = rows.filter((r) => !r.site.hasPassword || r.status.reachable === false || r.status.updatesError).length;
  const latest = rows.map((r) => r.status.collectedAt).filter(Boolean).sort().at(-1);
  return html`
${pageHead('Overzicht', { eyebrow: 'Fleet', sub: `Laatste data van n8n: ${fmtDate(latest)}`, actions: addButton })}
<div class="tiles">
  ${tile('Sites', rows.length)}
  ${tile('Bereikbaar', reachable, { sub: `van ${rows.length}`, gaugePct: (reachable / rows.length) * 100 })}
  ${tile('Updates open', updates, { tone: updates > 0 ? 'warn' : undefined, sub: 'plugins, thema\'s en core' })}
  ${tile('Problemen', problems, { tone: problems > 0 ? 'error' : undefined, sub: problems ? 'bekijk de sites met een rode stip' : 'alles in orde' })}
</div>
${panel({
  id: 'sites', title: 'Sites', icon: 'globe', meta: String(rows.length), open: true,
  body: html`<div class="table-wrap"><table>
    <thead><tr><th>Site</th><th>Status</th><th>WordPress</th><th>PHP</th><th>Bridge</th><th>Updates</th><th>Laatste data</th></tr></thead>
    <tbody>
      ${rows.map(
        ({ site, status }) => html`<tr>
          <td class="site-cell"><a href="/sites/${site.id}">${site.name}</a><br><small>${site.url}</small><br>
            ${site.tags.map((t) => html`<span class="tag">${t}</span>`)}
            ${site.readOnly ? html`<span class="tag">read-only</span>` : null}</td>
          <td>${statusBadge(site, status)}</td>
          <td class="version">${status.wpVersion ?? '—'}</td>
          <td class="version">${status.phpVersion ?? '—'}</td>
          <td class="version">${status.bridge ?? '—'}</td>
          <td>${updatesCell(status)}</td>
          <td><small>${fmtDate(status.collectedAt)}</small></td>
        </tr>`,
      )}
    </tbody>
  </table></div>`,
})}`;
}

export interface SiteFormValues {
  id: string;
  name: string;
  url: string;
  username: string;
  tags: string;
  readOnly: boolean;
  allowHttp: boolean;
  bridge: boolean;
  /** One site-relative path per line. */
  healthPaths: string;
}

export const emptySiteForm: SiteFormValues = {
  id: '',
  name: '',
  url: 'https://',
  username: 'mcp-bot',
  tags: '',
  readOnly: false,
  allowHttp: false,
  bridge: true,
  healthPaths: '',
};

export function siteFormPage(opts: {
  csrf: string;
  values: SiteFormValues;
  mode: 'create' | 'edit';
  hasPassword?: boolean;
  error?: string;
  offerSkipTest?: boolean;
  /** The username currently stored, shown on edit so an autofilled value stands out. */
  storedUsername?: string;
}) {
  const { csrf, values, mode, hasPassword, error, offerSkipTest, storedUsername } = opts;
  const action = mode === 'create' ? '/sites' : `/sites/${values.id}`;
  // Credential fields for *another* system: neutral names + password-manager ignore hints.
  const ignore = html`data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"`;
  return html`
${pageHead(mode === 'create' ? 'Site toevoegen' : html`Site bewerken: ${values.name}`, {
  eyebrow: mode === 'create' ? 'Nieuwe site' : values.id,
  sub: 'Bij opslaan wordt de verbinding eerst getest met deze gegevens.',
})}
<section class="card">
  ${error ? alert('error', error) : null}
  <form method="post" action="${action}" autocomplete="off">
    <input type="hidden" name="_csrf" value="${csrf}">
    <h2>Site</h2>
    <div class="grid">
      <label>Site-id <small>(kleine letters, cijfers, -)</small>
        <input name="id" value="${values.id}" required pattern="[a-z0-9][a-z0-9\\-]{1,48}" ${mode === 'edit' ? 'readonly' : ''}></label>
      <label>Naam <input name="name" value="${values.name}" required></label>
      <label>URL <input name="url" type="url" value="${values.url}" required></label>
      <label>Tags <small>(komma-gescheiden)</small><input name="tags" value="${values.tags}"></label>
    </div>
    <div class="form-section">
      <h2>WordPress-koppeling</h2>
      <div class="grid">
        <label>WordPress-gebruiker <small>(inlognaam of e-mailadres van de WP-gebruiker)</small>
          <input name="wp_user" value="${values.username}" required autocomplete="off" spellcheck="false" ${ignore}>
          ${mode === 'edit' && storedUsername ? html`<small>Opgeslagen: <code>${storedUsername}</code></small>` : null}</label>
        <label>Application Password
          <input name="app_password" type="password" autocomplete="new-password" ${mode === 'create' ? 'required' : ''} ${ignore}
            placeholder="${mode === 'edit' ? (hasPassword ? 'Laat leeg om ongewijzigd te laten' : 'Nog niet ingesteld') : 'xxxx xxxx xxxx xxxx xxxx xxxx'}">
          <small>Wordt versleuteld opgeslagen en nooit meer getoond.</small></label>
      </div>
    </div>
    <div class="form-section">
      <h2>Controle na veilige updates</h2>
      <label>Extra controle-pagina's <small>(één pad per regel, bijv. /winkel — naast homepage en inlogpagina)</small>
        <textarea name="healthPaths" rows="3" placeholder="/winkel">${values.healthPaths}</textarea></label>
    </div>
    <div class="form-section">
      <h2>Opties</h2>
      <fieldset class="checks">
        <label><input type="checkbox" name="readOnly" ${values.readOnly ? 'checked' : ''}> Alleen lezen (geen wijzigingen via MCP of dashboard)</label>
        <label><input type="checkbox" name="bridge" ${values.bridge ? 'checked' : ''}> nb-mcp-bridge geïnstalleerd</label>
        <label><input type="checkbox" name="allowHttp" ${values.allowHttp ? 'checked' : ''}> http:// toestaan (alleen lokaal/test)</label>
        ${offerSkipTest
          ? html`<label class="warn"><input type="checkbox" name="skipTest"> Toch opslaan zonder geslaagde verbindingstest</label>`
          : null}
      </fieldset>
    </div>
    <div class="form-foot">
      <button type="submit" data-busy="Verbinding testen…">${icon('plug')} Testen en opslaan</button>
      <a class="button secondary" href="${mode === 'edit' ? `/sites/${values.id}` : '/'}">Annuleren</a>
    </div>
  </form>
</section>`;
}

function hero(csrf: string, site: StoredSite, status: SiteStatus): SafeHtml {
  const updates = pendingUpdates(status);
  return html`<section class="hero">
  <p class="eyebrow">${site.id}</p>
  <div class="hero-title"><h1>${site.name}</h1>${statusBadge(site, status)}</div>
  ${/^https?:\/\//.test(site.url)
    ? html`<a class="hero-url" href="${site.url}" rel="noopener noreferrer" target="_blank">${site.url} ${icon('external')}</a>`
    : html`<span class="hero-url">${site.url}</span>`}
  <div class="chips">
    <span class="chip"><small>WordPress</small><b>${status.wpVersion ?? '—'}</b></span>
    <span class="chip"><small>PHP</small><b>${status.phpVersion ?? '—'}</b></span>
    <span class="chip"><small>Bridge</small><b>${site.bridge ? (status.bridge ?? '—') : 'uit'}</b></span>
    <span class="chip"><small>Updates</small><b>${status.updates ? String(updates) : '—'}</b></span>
    <span class="chip"><small>Laatste data</small><b>${fmtDate(status.collectedAt)}</b></span>
  </div>
  ${status.reachable === false && status.error
    ? alert('error', html`Laatste controle door n8n mislukt: ${status.error} <small>(wordt bij de volgende n8n-run opnieuw gecontroleerd; "Verbinding testen" controleert nu)</small>`)
    : null}
  <div class="actions">
    <a class="button" href="/sites/${site.id}/edit">${icon('edit')} Bewerken</a>
    <a class="button secondary" href="/sites/${site.id}/users">${icon('users')} Gebruikers</a>
    <form method="post" action="/sites/${site.id}/test" class="inline">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit" class="secondary" data-busy="Verbinding testen…">${icon('plug')} Verbinding testen</button>
    </form>
  </div>
</section>`;
}

export function siteDetailPage(opts: {
  csrf: string;
  site: StoredSite;
  status: SiteStatus;
  snapshots: SnapshotRow[];
  updates: SafeHtml;
  audit: AuditRow[];
}) {
  const { csrf, site, status, snapshots, updates, audit } = opts;
  return html`
${hero(csrf, site, status)}
${updates}
${panel({
  id: 'config', title: 'Configuratie', icon: 'sliders',
  body: html`<dl class="meta">
    <dt>Site-id</dt><dd><code>${site.id}</code></dd>
    <dt>Gebruiker</dt><dd>${site.username}</dd>
    <dt>Wachtwoord</dt><dd>${site.hasPassword ? 'ingesteld (versleuteld)' : 'ontbreekt'}</dd>
    <dt>Tags</dt><dd>${site.tags.join(', ') || '—'}</dd>
    <dt>Opties</dt><dd>${[site.readOnly && 'alleen lezen', site.bridge ? 'bridge' : 'geen bridge', site.allowHttp && 'http toegestaan'].filter(Boolean).join(' · ')}</dd>
    <dt>Extra controle-pagina's</dt><dd>${site.healthPaths.join(', ') || '—'}</dd>
    <dt>Toegevoegd</dt><dd>${fmtDate(site.createdAt)}</dd>
    <dt>Gewijzigd</dt><dd>${fmtDate(site.updatedAt)}</dd>
  </dl>`,
})}
${panel({
  id: 'n8n', title: 'Laatste data van n8n', icon: 'activity', meta: snapshots.length ? `${snapshots.length} rapport(en)` : null,
  body: snapshots.length === 0
    ? html`<div class="empty">${icon('activity')}<span>Nog geen data ontvangen voor deze site.</span></div>`
    : snapshots.map(
        (s) => html`<details class="raw"><summary><strong>${s.kind}</strong> · <small>${fmtDate(s.collected_at)}</small></summary>
          <pre>${JSON.stringify(JSON.parse(s.data), null, 2)}</pre></details>`,
      ),
})}
${panel({ id: 'history', title: 'Recente wijzigingen', icon: 'clock', meta: audit.length ? String(audit.length) : null, body: auditTable(audit) })}
${panel({
  id: 'danger', title: 'Gevarenzone', icon: 'alert', tone: 'danger',
  body: html`<p>Verwijdert de site en het versleutelde wachtwoord uit het dashboard en de MCP-server. De WordPress-site zelf blijft ongewijzigd.</p>
    <form method="post" action="/sites/${site.id}/delete" class="inline">
      <input type="hidden" name="_csrf" value="${csrf}">
      <label class="confirm"><input type="checkbox" name="confirm" required> zeker weten</label>
      <button type="submit" class="danger">${icon('trash')} Site verwijderen</button>
    </form>`,
})}`;
}

export function auditTable(rows: AuditRow[]) {
  if (rows.length === 0) return html`<div class="empty">${icon('clock')}<span>Nog niets gelogd.</span></div>`;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Tijd</th><th>Wie</th><th>Actie</th><th>Doel</th><th>Details</th></tr></thead>
    <tbody>${rows.map(
      (r) => html`<tr><td><small>${fmtDate(r.ts)}</small></td><td>${r.actor}</td><td><code>${r.action}</code></td>
        <td>${r.target ?? '—'}</td><td><small>${r.details ?? ''}</small></td></tr>`,
    )}</tbody></table></div>`;
}

export function auditPage(rows: AuditRow[]) {
  return html`${pageHead('Audit-log', { eyebrow: 'Beheer', sub: 'Alle wijzigingen via het dashboard, nieuwste eerst.' })}
<section class="card">${auditTable(rows)}</section>`;
}

export function settingsPage(opts: { csrf: string; email: string; ingestLastSeen?: string }) {
  return html`
${pageHead('Instellingen', { eyebrow: 'Beheer' })}
<section class="card">
  <h2>Account</h2>
  <dl class="meta">
    <dt>Account</dt><dd>${opts.email}</dd>
    <dt>Tweestapsverificatie</dt><dd><span class="badge ok">${statusDot('ok')} actief</span></dd>
    <dt>Laatste data van n8n</dt><dd>${fmtDate(opts.ingestLastSeen)}</dd>
  </dl>
</section>
<section class="card">
  <h2>Tweestapsverificatie</h2>
  <p class="hint">Koppel een nieuwe authenticator-app. Je logt daarna opnieuw in.</p>
  <form method="post" action="/settings/totp-reset" class="inline">
    <input type="hidden" name="_csrf" value="${opts.csrf}">
    <label class="confirm"><input type="checkbox" name="confirm" required> ik wil een nieuwe authenticator koppelen</label>
    <button type="submit" class="secondary">Opnieuw instellen</button>
  </form>
  <p class="hint">Het wachtwoord van dit account wijzig je via het GitHub-secret <code>ADMIN_PASSWORD</code> en een nieuwe deploy.</p>
</section>`;
}
