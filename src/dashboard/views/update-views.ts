import type { StoredSite } from '../../store/site-store.js';
import { selectCoreUpdate, stripPhp } from '../../wp/updates.js';
import type { UpdateItemResult, UpdatesSnapshot } from '../updates.js';
import { html, type SafeHtml } from './html.js';

const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '—';

const version = (from?: string, to?: string) => html`<code>${from ?? '?'}</code> → <code>${to ?? '?'}</code>`;

function refreshForm(csrf: string, siteId: string, label = 'Opnieuw controleren') {
  return html`<form method="post" action="/sites/${siteId}/updates/refresh" class="inline">
    <input type="hidden" name="_csrf" value="${csrf}">
    <button type="submit" class="secondary" data-busy="Controleren…">${label}</button>
  </form>`;
}

function coreRows(updates: NonNullable<UpdatesSnapshot['data']>) {
  const offers = updates.core ?? [];
  const minor = selectCoreUpdate(offers, false).chosen;
  const any = selectCoreUpdate(offers, true).chosen;
  const major = any && any.type === 'major' ? any : undefined;
  if (!minor && !major) return null;
  return html`
  <h3>WordPress</h3>
  <table class="updates">
    <tbody>
      <tr>
        <td class="check"><input type="checkbox" name="core" id="upd-core"></td>
        <td><label for="upd-core">WordPress-core</label></td>
        <td>${minor ? version(minor.current, minor.version) : html`<small>geen minor-update</small>`}</td>
      </tr>
      ${major
        ? html`<tr class="major">
            <td class="check"><input type="checkbox" name="allow_major" id="upd-major"></td>
            <td><label for="upd-major">Major-versie toestaan</label></td>
            <td>${version(major.current, major.version)} <span class="badge warn">major</span>
              <br><small>Alleen samen met "WordPress-core". Maak eerst een backup en test na afloop.</small></td>
          </tr>`
        : null}
    </tbody>
  </table>`;
}

function itemRows(
  title: string,
  field: 'plugins' | 'themes',
  items: Array<{ id: string; value: string; name?: string; from?: string; to?: string; packageAvailable?: boolean }>,
) {
  if (items.length === 0) return null;
  return html`
  <h3>${title} <small>(${items.length})</small></h3>
  <table class="updates">
    <thead><tr><th class="check"><input type="checkbox" data-select-all="${field}" aria-label="Alles selecteren"></th><th>Naam</th><th>Versie</th></tr></thead>
    <tbody>
      ${items.map((item, i) => {
        const id = `upd-${field}-${i}`;
        const blocked = item.packageAvailable === false;
        return html`<tr>
          <td class="check"><input type="checkbox" name="${field}" value="${item.value}" id="${id}" ${blocked ? 'disabled' : ''}></td>
          <td><label for="${id}">${item.name ?? item.id}</label><br><small>${item.id}</small></td>
          <td>${version(item.from, item.to)}${blocked ? html`<br><small class="warn">Geen downloadpakket (licentie/premium) — bijwerken via WP-admin.</small>` : null}</td>
        </tr>`;
      })}
    </tbody>
  </table>`;
}

/** "Updates" section on the site detail page, built from the latest update snapshot. */
export function updatesSection(opts: { csrf: string; site: StoredSite; snapshot?: UpdatesSnapshot }): SafeHtml {
  const { csrf, site, snapshot } = opts;
  const header = html`<div class="section-head"><h2 id="updates">Updates</h2>${site.bridge ? refreshForm(csrf, site.id) : null}</div>`;
  if (!site.bridge) {
    return html`<section class="card">${header}<p>Updates vereisen de nb-mcp-bridge; die staat uit voor deze site.</p></section>`;
  }
  if (!snapshot) {
    return html`<section class="card">${header}<p>Nog geen update-gegevens. Klik op "Opnieuw controleren" of wacht op de volgende n8n-run.</p></section>`;
  }
  if (snapshot.error || !snapshot.data) {
    return html`<section class="card">${header}
      <p class="flash error">Update-check mislukt (${fmtDate(snapshot.collectedAt)}): ${snapshot.error}</p></section>`;
  }
  const data = snapshot.data;
  const plugins = (data.plugins ?? []).map((p) => ({
    id: stripPhp(p.plugin), value: p.plugin, name: p.name, from: p.current_version, to: p.new_version, packageAvailable: p.package_available,
  }));
  const themes = (data.themes ?? []).map((t) => ({
    id: t.stylesheet, value: t.stylesheet, name: t.name, from: t.current_version, to: t.new_version, packageAvailable: t.package_available,
  }));
  const translations = data.translations?.count ?? 0;
  const core = coreRows(data);
  const nothing = !core && plugins.length === 0 && themes.length === 0 && translations === 0;

  return html`
<section class="card">
  ${header}
  <p class="hint">Gegevens van ${fmtDate(snapshot.collectedAt)}. Vóór het uitvoeren wordt live gecontroleerd wat er echt openstaat.</p>
  ${nothing
    ? html`<p><span class="badge ok">up-to-date</span> Er zijn geen updates beschikbaar.</p>`
    : site.readOnly
      ? html`<p class="flash error">Deze site staat op "alleen lezen"; updates uitvoeren is uitgeschakeld.</p>
          ${core}${itemRows('Plugins', 'plugins', plugins)}${itemRows("Thema's", 'themes', themes)}`
      : html`<form method="post" action="/sites/${site.id}/updates">
          <input type="hidden" name="_csrf" value="${csrf}">
          ${core}
          ${itemRows('Plugins', 'plugins', plugins)}
          ${itemRows("Thema's", 'themes', themes)}
          ${translations > 0
            ? html`<h3>Vertalingen</h3><label class="plain"><input type="checkbox" name="translations"> ${translations} vertaling(en) bijwerken</label>`
            : null}
          <div class="run">
            <label class="confirm"><input type="checkbox" name="confirm" required> Ik heb een recente backup en wil de geselecteerde updates nu uitvoeren</label>
            <button type="submit" data-busy="Bezig met bijwerken… (dit kan enkele minuten duren)">Geselecteerde bijwerken</button>
          </div>
        </form>`}
</section>`;
}

const STATUS_LABEL: Record<UpdateItemResult['status'], SafeHtml> = {
  updated: html`<span class="badge ok">bijgewerkt</span>`,
  up_to_date: html`<span class="badge muted">was al actueel</span>`,
  skipped: html`<span class="badge warn">overgeslagen</span>`,
  failed: html`<span class="badge error">mislukt</span>`,
};

const KIND_LABEL: Record<UpdateItemResult['kind'], string> = {
  core: 'WordPress', plugin: 'Plugin', theme: 'Thema', translations: 'Vertalingen',
};

export function updateResultPage(opts: { site: StoredSite; results: UpdateItemResult[]; names: Map<string, string> }): SafeHtml {
  const { site, results, names } = opts;
  const failed = results.filter((r) => r.status === 'failed').length;
  return html`
<section class="card">
  <h1>Updates uitgevoerd: ${site.name}</h1>
  <p class="flash ${failed > 0 ? 'error' : 'ok'}">${failed > 0
    ? `${failed} van ${results.length} onderdelen zijn mislukt.`
    : `Alle ${results.length} onderdelen zijn verwerkt.`}</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Soort</th><th>Onderdeel</th><th>Versie</th><th>Resultaat</th></tr></thead>
    <tbody>${results.map(
      (r) => html`<tr>
        <td>${KIND_LABEL[r.kind]}</td>
        <td>${names.get(r.id) ?? r.id}${names.has(r.id) ? html`<br><small>${r.id}</small>` : null}</td>
        <td>${r.from || r.to ? version(r.from, r.to) : '—'}</td>
        <td>${STATUS_LABEL[r.status]}${r.message ? html`<br><small>${r.message}</small>` : null}</td>
      </tr>`,
    )}</tbody>
  </table></div>
  <p class="hint">Controleer de site na afloop even in de browser.</p>
  <div class="actions"><a class="button" href="/sites/${site.id}#updates">Terug naar de site</a></div>
</section>`;
}
