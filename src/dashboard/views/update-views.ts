import type { StoredSite } from '../../store/site-store.js';
import { selectCoreUpdate, stripPhp } from '../../wp/updates.js';
import type { UpdateItemResult, UpdatesSnapshot } from '../updates.js';
import { alert, pageHead, panel, subPanel } from './components.js';
import { html, type SafeHtml } from './html.js';
import { icon } from './icons.js';

const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '—';

const version = (from?: string, to?: string) =>
  html`<span class="version">${from ?? '?'}<span class="arrow">→</span>${to ?? '?'}</span>`;

function refreshForm(csrf: string, siteId: string, label = 'Opnieuw controleren') {
  return html`<form method="post" action="/sites/${siteId}/updates/refresh" class="inline">
    <input type="hidden" name="_csrf" value="${csrf}">
    <button type="submit" class="secondary" data-busy="Updates controleren…">${icon('refresh')} ${label}</button>
  </form>`;
}

function coreRows(updates: NonNullable<UpdatesSnapshot['data']>) {
  const offers = updates.core ?? [];
  const minor = selectCoreUpdate(offers, false).chosen;
  const any = selectCoreUpdate(offers, true).chosen;
  const major = any && any.type === 'major' ? any : undefined;
  if (!minor && !major) return null;
  return subPanel('WordPress', minor || major ? 1 : 0, html`
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
  </table>`);
}

function itemRows(
  title: string,
  field: 'plugins' | 'themes',
  items: Array<{ id: string; value: string; name?: string; from?: string; to?: string; packageAvailable?: boolean }>,
) {
  if (items.length === 0) return null;
  return subPanel(title, items.length, html`
  <div class="table-wrap"><table class="updates">
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
  </table></div>`);
}

/** "Updates" panel on the site detail page, built from the latest update snapshot. */
export function updatesSection(opts: { csrf: string; site: StoredSite; snapshot?: UpdatesSnapshot }): SafeHtml {
  const { csrf, site, snapshot } = opts;
  const section = (body: SafeHtml, meta?: string | SafeHtml | null) =>
    panel({ id: 'updates', title: 'Updates', icon: 'download', meta, open: true, body });
  if (!site.bridge) {
    return section(html`<div class="empty">${icon('info')}<span>Updates vereisen de nb-mcp-bridge; die staat uit voor deze site.</span></div>`);
  }
  const toolbar = (text: string | SafeHtml) => html`<div class="toolbar"><p class="hint">${text}</p>${refreshForm(csrf, site.id)}</div>`;
  if (!snapshot) {
    return section(html`${toolbar('')}<div class="empty">${icon('download')}<span>Nog geen update-gegevens. Klik op "Opnieuw controleren" of wacht op de volgende n8n-run.</span></div>`);
  }
  if (snapshot.error || !snapshot.data) {
    return section(html`${toolbar('')}${alert('error', `Update-check mislukt (${fmtDate(snapshot.collectedAt)}): ${snapshot.error}`)}`,
      html`<span class="badge error">fout</span>`);
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
  const total = plugins.length + themes.length + (core ? 1 : 0);
  const meta = nothing ? html`<span class="badge ok">up-to-date</span>` : html`<span class="badge warn">${String(total)} open</span>`;
  const head = toolbar(`Gegevens van ${fmtDate(snapshot.collectedAt)}. Vóór het uitvoeren wordt live gecontroleerd wat er echt openstaat.`);

  if (nothing) {
    return section(html`${head}<div class="empty">${icon('check')}<span>Er zijn geen updates beschikbaar.</span></div>`, meta);
  }
  if (site.readOnly) {
    return section(html`${head}${alert('warn', 'Deze site staat op "alleen lezen"; updates uitvoeren is uitgeschakeld.')}
      ${core}${itemRows('Plugins', 'plugins', plugins)}${itemRows("Thema's", 'themes', themes)}`, meta);
  }
  return section(html`${head}
  <form method="post" action="/sites/${site.id}/updates">
    <input type="hidden" name="_csrf" value="${csrf}">
    ${core}
    ${itemRows('Plugins', 'plugins', plugins)}
    ${itemRows("Thema's", 'themes', themes)}
    ${translations > 0
      ? subPanel('Vertalingen', translations, html`<label class="plain"><input type="checkbox" name="translations"> ${String(translations)} vertaling(en) bijwerken</label>`)
      : null}
    <fieldset class="safe">
      <label class="plain"><input type="checkbox" name="safe" checked> ${icon('shield')} <strong>Veilig updaten</strong>: backup, controle en automatisch terugzetten</label>
      <small>Per onderdeel maakt de server eerst een bestandsbackup, voert de update uit en controleert
      de homepage, de inlogpagina${site.healthPaths.length ? html`, ${site.healthPaths.join(', ')}` : null} en het PHP-errorlog.
      Gaat er iets mis, dan wordt het onderdeel direct teruggezet; anders wordt de backup verwijderd.
      WordPress major-updates worden alleen gecontroleerd, niet teruggezet. De database wordt nooit teruggezet.</small>
    </fieldset>
    <div class="run">
      <label class="confirm"><input type="checkbox" name="confirm" required> Ik wil de geselecteerde updates nu uitvoeren</label>
      <button type="submit" data-busy="Bezig met bijwerken… dit kan enkele minuten duren">${icon('download')} Geselecteerde bijwerken</button>
    </div>
  </form>`, meta);
}

const STATUS_LABEL: Record<UpdateItemResult['status'], SafeHtml> = {
  updated: html`<span class="badge ok">bijgewerkt</span>`,
  up_to_date: html`<span class="badge muted">was al actueel</span>`,
  skipped: html`<span class="badge warn">overgeslagen</span>`,
  failed: html`<span class="badge error">mislukt</span>`,
  rolled_back: html`<span class="badge warn">teruggezet</span>`,
  rollback_failed: html`<span class="badge error">terugzetten mislukt — handmatig ingrijpen</span>`,
};

const KIND_LABEL: Record<UpdateItemResult['kind'], string> = {
  core: 'WordPress', plugin: 'Plugin', theme: 'Thema', translations: 'Vertalingen',
};

export function updateResultPage(opts: { site: StoredSite; results: UpdateItemResult[]; names: Map<string, string> }): SafeHtml {
  const { site, results, names } = opts;
  const count = (...statuses: UpdateItemResult['status'][]) => results.filter((r) => statuses.includes(r.status)).length;
  const failed = count('failed', 'rollback_failed');
  const rolledBack = count('rolled_back');
  const critical = count('rollback_failed') > 0;
  const tile = (label: string, value: number, tone = '') =>
    html`<div class="tile ${tone}"><div><div class="tile-label">${label}</div><div class="tile-num" data-count="${String(value)}">${String(value)}</div></div></div>`;
  return html`
${pageHead(html`Updates uitgevoerd: ${site.name}`, { eyebrow: site.id, actions: html`<a class="button" href="/sites/${site.id}#updates">Terug naar de site</a>` })}
${critical ? alert('error', html`<strong>Let op:</strong> bij minstens één onderdeel is het terugzetten mislukt. Controleer de site nu; de backup is bewaard (zie hieronder).`) : null}
${alert(failed > 0 ? 'error' : rolledBack > 0 ? 'warn' : 'ok', failed > 0
  ? `${failed} van ${results.length} onderdelen zijn mislukt.`
  : rolledBack > 0
    ? `${rolledBack} van ${results.length} onderdelen gaven fouten en zijn automatisch teruggezet; de rest is verwerkt.`
    : `Alle ${results.length} onderdelen zijn verwerkt.`)}
<div class="result-tiles">
  ${tile('Bijgewerkt', count('updated'))}
  ${tile('Al actueel', count('up_to_date', 'skipped'))}
  ${tile('Teruggezet', rolledBack, rolledBack ? 'warn' : '')}
  ${tile('Mislukt', failed, failed ? 'error' : '')}
</div>
<section class="card">
  <div class="table-wrap"><table>
    <thead><tr><th>Soort</th><th>Onderdeel</th><th>Versie</th><th>Resultaat</th></tr></thead>
    <tbody>${results.map(
      (r) => html`<tr>
        <td>${KIND_LABEL[r.kind]}</td>
        <td><strong>${names.get(r.id) ?? r.id}</strong>${names.has(r.id) ? html`<br><small>${r.id}</small>` : null}</td>
        <td>${r.from || r.to ? version(r.from, r.to) : '—'}</td>
        <td>${STATUS_LABEL[r.status]}${r.message ? html`<br><small>${r.message}</small>` : null}</td>
      </tr>`,
    )}</tbody>
  </table></div>
  <p class="hint">Controleer de site na afloop even in de browser.</p>
</section>`;
}
