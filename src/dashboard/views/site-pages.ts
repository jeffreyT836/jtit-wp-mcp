import type { StoredSite } from '../../store/site-store.js';
import type { AuditRow, SnapshotRow } from '../db.js';
import type { SiteStatus } from '../snapshots.js';
import { html, type SafeHtml } from './html.js';

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '—';

function statusBadge(site: StoredSite, status: SiteStatus) {
  if (!site.hasPassword) return html`<span class="badge error">geen wachtwoord</span>`;
  if (status.reachable === undefined) return html`<span class="badge muted">nog geen data</span>`;
  return status.reachable
    ? html`<span class="badge ok">bereikbaar</span>`
    : html`<span class="badge error" title="${status.error ?? ''}">fout</span>`;
}

function updatesCell(status: SiteStatus) {
  if (status.updatesError) return html`<span class="badge warn" title="${status.updatesError}">fout</span>`;
  if (!status.updates) return '—';
  const { core, plugins, themes } = status.updates;
  const total = core + plugins + themes;
  return total === 0
    ? html`<span class="badge ok">up-to-date</span>`
    : html`<span class="badge warn">${total}</span> <small>core ${core} · plugins ${plugins} · thema's ${themes}</small>`;
}

export function overviewPage(rows: { site: StoredSite; status: SiteStatus }[]) {
  if (rows.length === 0) {
    return html`<section class="card"><h1>Sites</h1>
      <p>Nog geen sites. <a href="/sites/new">Voeg je eerste site toe</a>.</p></section>`;
  }
  return html`
<section class="card">
  <h1>Sites <small>(${rows.length})</small></h1>
  <div class="table-wrap"><table>
    <thead><tr><th>Site</th><th>Status</th><th>WordPress</th><th>PHP</th><th>Bridge</th><th>Updates</th><th>Laatste data</th></tr></thead>
    <tbody>
      ${rows.map(
        ({ site, status }) => html`<tr>
          <td><a href="/sites/${site.id}"><strong>${site.name}</strong></a><br><small>${site.url}</small>
            ${site.tags.map((t) => html` <span class="tag">${t}</span>`)}
            ${site.readOnly ? html` <span class="tag">read-only</span>` : null}</td>
          <td>${statusBadge(site, status)}</td>
          <td>${status.wpVersion ?? '—'}</td>
          <td>${status.phpVersion ?? '—'}</td>
          <td>${status.bridge ?? '—'}</td>
          <td>${updatesCell(status)}</td>
          <td><small>${fmtDate(status.collectedAt)}</small></td>
        </tr>`,
      )}
    </tbody>
  </table></div>
</section>`;
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
  return html`
<section class="card">
  <h1>${mode === 'create' ? 'Site toevoegen' : html`Site bewerken: ${values.name}`}</h1>
  ${error ? html`<p class="flash error" role="alert">${error}</p>` : null}
  <form method="post" action="${action}" autocomplete="off">
    <input type="hidden" name="_csrf" value="${csrf}">
    <div class="grid">
      <label>Site-id <small>(kleine letters, cijfers, -)</small>
        <input name="id" value="${values.id}" required pattern="[a-z0-9][a-z0-9\\-]{1,48}" ${mode === 'edit' ? 'readonly' : ''}></label>
      <label>Naam <input name="name" value="${values.name}" required></label>
      <label>URL <input name="url" type="url" value="${values.url}" required></label>
      <label>WordPress-gebruiker <small>(inlognaam of e-mailadres van de WP-gebruiker)</small>
        <input name="wp_user" value="${values.username}" required autocomplete="off" spellcheck="false"
          data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">
        ${mode === 'edit' && storedUsername ? html`<small>Opgeslagen: <code>${storedUsername}</code></small>` : null}</label>
      <label>Tags <small>(komma-gescheiden)</small><input name="tags" value="${values.tags}"></label>
      <label>Application Password
        <input name="app_password" type="password" autocomplete="new-password" ${mode === 'create' ? 'required' : ''}
          data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"
          placeholder="${mode === 'edit' ? (hasPassword ? 'Laat leeg om ongewijzigd te laten' : 'Nog niet ingesteld') : 'xxxx xxxx xxxx xxxx xxxx xxxx'}">
        <small>Wordt versleuteld opgeslagen en nooit meer getoond.</small></label>
    </div>
    <label>Extra controle-pagina's <small>(één pad per regel, bijv. /winkel — gecontroleerd na veilige updates, naast homepage en inlogpagina)</small>
      <textarea name="healthPaths" rows="3" placeholder="/winkel">${values.healthPaths}</textarea></label>
    <fieldset class="checks">
      <label><input type="checkbox" name="readOnly" ${values.readOnly ? 'checked' : ''}> Alleen lezen (geen wijzigingen via MCP)</label>
      <label><input type="checkbox" name="bridge" ${values.bridge ? 'checked' : ''}> nb-mcp-bridge geïnstalleerd</label>
      <label><input type="checkbox" name="allowHttp" ${values.allowHttp ? 'checked' : ''}> http:// toestaan (alleen lokaal/test)</label>
      ${offerSkipTest
        ? html`<label class="warn"><input type="checkbox" name="skipTest"> Toch opslaan zonder geslaagde verbindingstest</label>`
        : null}
    </fieldset>
    <p class="hint">Bij opslaan wordt de verbinding eerst getest met deze gegevens.</p>
    <button type="submit">Testen en opslaan</button>
    <a class="button secondary" href="${mode === 'edit' ? `/sites/${values.id}` : '/'}">Annuleren</a>
  </form>
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
<section class="card">
  <h1>${site.name} ${statusBadge(site, status)}</h1>
  <p>${/^https?:\/\//.test(site.url)
    ? html`<a href="${site.url}" rel="noopener noreferrer" target="_blank">${site.url}</a>`
    : site.url}</p>
  <dl class="meta">
    <dt>Site-id</dt><dd><code>${site.id}</code></dd>
    <dt>Gebruiker</dt><dd>${site.username}</dd>
    <dt>Wachtwoord</dt><dd>${site.hasPassword ? 'ingesteld (versleuteld)' : 'ontbreekt'}</dd>
    <dt>Tags</dt><dd>${site.tags.join(', ') || '—'}</dd>
    <dt>Opties</dt><dd>${[site.readOnly && 'alleen lezen', site.bridge ? 'bridge' : 'geen bridge', site.allowHttp && 'http toegestaan'].filter(Boolean).join(' · ')}</dd>
    <dt>Toegevoegd</dt><dd>${fmtDate(site.createdAt)}</dd>
    <dt>Gewijzigd</dt><dd>${fmtDate(site.updatedAt)}</dd>
  </dl>
  <div class="actions">
    <a class="button" href="/sites/${site.id}/edit">Bewerken</a>
    <a class="button secondary" href="/sites/${site.id}/users">Gebruikers</a>
    <form method="post" action="/sites/${site.id}/test" class="inline">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit" class="secondary">Verbinding testen</button>
    </form>
    <form method="post" action="/sites/${site.id}/delete" class="inline">
      <input type="hidden" name="_csrf" value="${csrf}">
      <label class="confirm"><input type="checkbox" name="confirm" required> zeker weten</label>
      <button type="submit" class="danger">Verwijderen</button>
    </form>
  </div>
</section>
${updates}
<section class="card">
  <h2>Laatste data van n8n</h2>
  ${snapshots.length === 0
    ? html`<p>Nog geen data ontvangen voor deze site.</p>`
    : snapshots.map(
        (s) => html`<details><summary><strong>${s.kind}</strong> · ${fmtDate(s.collected_at)}</summary>
          <pre>${JSON.stringify(JSON.parse(s.data), null, 2)}</pre></details>`,
      )}
</section>
<section class="card">
  <h2>Recente wijzigingen</h2>
  ${auditTable(audit)}
</section>`;
}

export function auditTable(rows: AuditRow[]) {
  if (rows.length === 0) return html`<p>Nog niets gelogd.</p>`;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Tijd</th><th>Wie</th><th>Actie</th><th>Doel</th><th>Details</th></tr></thead>
    <tbody>${rows.map(
      (r) => html`<tr><td><small>${fmtDate(r.ts)}</small></td><td>${r.actor}</td><td>${r.action}</td>
        <td>${r.target ?? '—'}</td><td><small>${r.details ?? ''}</small></td></tr>`,
    )}</tbody></table></div>`;
}

export function auditPage(rows: AuditRow[]) {
  return html`<section class="card"><h1>Audit-log</h1>${auditTable(rows)}</section>`;
}

export function settingsPage(opts: { csrf: string; email: string; ingestLastSeen?: string }) {
  return html`
<section class="card">
  <h1>Instellingen</h1>
  <dl class="meta">
    <dt>Account</dt><dd>${opts.email}</dd>
    <dt>Tweestapsverificatie</dt><dd>actief</dd>
    <dt>Laatste data van n8n</dt><dd>${fmtDate(opts.ingestLastSeen)}</dd>
  </dl>
  <form method="post" action="/settings/totp-reset" class="inline">
    <input type="hidden" name="_csrf" value="${opts.csrf}">
    <label class="confirm"><input type="checkbox" name="confirm" required> ik wil een nieuwe authenticator koppelen</label>
    <button type="submit" class="secondary">Tweestapsverificatie opnieuw instellen</button>
  </form>
  <p class="hint">Het wachtwoord van dit account wijzig je via het GitHub-secret <code>ADMIN_PASSWORD</code> en een nieuwe deploy.</p>
</section>`;
}
