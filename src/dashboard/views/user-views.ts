import type { RoleSummary, UserSummary } from '../../wp/users.js';
import { MIN_PASSWORD_LENGTH, type NewUserFormValues } from '../users.js';
import { alert, pageHead, panel } from './components.js';
import { html, type SafeHtml } from './html.js';
import { icon } from './icons.js';

const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '—';

/** Where the users live: a whole site, or one site of a multisite network. */
export interface UserScopeView {
  basePath: string;
  title: string | SafeHtml;
  eyebrow: string;
  backHref: string;
  backLabel: string;
  /** Multisite: removing takes the user off this site only; usernames follow network rules. */
  network: boolean;
  readOnly: boolean;
}

export const emptyNewUser: NewUserFormValues = { username: '', email: '', role: 'subscriber', firstName: '', lastName: '' };

function roleNames(roles: RoleSummary[], slugs: string[]) {
  if (slugs.length === 0) return html`<small>geen rol</small>`;
  return slugs.map((slug) => {
    const name = roles.find((r) => r.slug === slug)?.name ?? slug;
    return html`<span class="badge ${slug === 'administrator' ? 'role-admin' : 'muted'}">${name}</span> `;
  });
}

function deleteForm(csrf: string, scope: UserScopeView, user: UserSummary, users: UserSummary[], meId?: number) {
  const others = users.filter((u) => u.id !== user.id);
  if (others.length === 0) return html`<small>—</small>`;
  const defaultTarget = meId && meId !== user.id ? meId : others[0]!.id;
  const verb = scope.network ? 'van deze site verwijderen' : 'definitief verwijderen';
  return html`<details class="delete-user"><summary>${icon('trash')} ${scope.network ? 'Van site verwijderen' : 'Verwijderen'}</summary>
    <form method="post" action="${scope.basePath}/${String(user.id)}/delete">
      <input type="hidden" name="_csrf" value="${csrf}">
      <label>Berichten en pagina's overdragen aan
        <select name="reassign">${others.map(
          (u) => html`<option value="${String(u.id)}" ${u.id === defaultTarget ? 'selected' : ''}>${u.username}${u.name && u.name !== u.username ? ` (${u.name})` : ''}</option>`,
        )}</select></label>
      <label class="confirm"><input type="checkbox" name="confirm" required> ${user.username} ${verb}</label>
      ${scope.network ? html`<small>Het account blijft in het netwerk bestaan.</small>` : null}
      <button type="submit" class="danger" data-busy="Gebruiker verwijderen…">${icon('trash')} ${scope.network ? 'Van site verwijderen' : 'Definitief verwijderen'}</button>
    </form></details>`;
}

function createForm(csrf: string, scope: UserScopeView, roles: RoleSummary[], values: NewUserFormValues) {
  // Field names are not "username"/"password" so password managers don't fill in the
  // dashboard's own login; autocomplete=new-password lets them offer a generated one.
  const ignore = html`data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"`;
  const usernameRule = scope.network
    ? html`<small>(kleine letters en cijfers, minstens 4 — regel van WordPress-multisite)</small>
        <input name="new_user_login" value="${values.username}" required minlength="4" maxlength="60" pattern="[a-z0-9]{4,60}"
          autocomplete="off" spellcheck="false" ${ignore}>`
    : html`<small>(letters, cijfers, _ . @ -)</small>
        <input name="new_user_login" value="${values.username}" required maxlength="60" pattern="[A-Za-z0-9_.@\\-]+"
          autocomplete="off" spellcheck="false" ${ignore}>`;
  return html`<form method="post" action="${scope.basePath}" autocomplete="off">
    <input type="hidden" name="_csrf" value="${csrf}">
    <div class="grid">
      <label>Gebruikersnaam ${usernameRule}</label>
      <label>E-mailadres <input name="new_user_email" type="email" value="${values.email}" required maxlength="100" autocomplete="off" ${ignore}></label>
      <label>Voornaam <small>(optioneel)</small><input name="new_user_first" value="${values.firstName}" maxlength="100" autocomplete="off" ${ignore}></label>
      <label>Achternaam <small>(optioneel)</small><input name="new_user_last" value="${values.lastName}" maxlength="100" autocomplete="off" ${ignore}></label>
      <label>Rol
        <select name="new_user_role" required>${roles.map(
          (r) => html`<option value="${r.slug}" ${r.slug === values.role ? 'selected' : ''}>${r.name}</option>`,
        )}</select>
        <small>Een beheerder krijgt volledige toegang tot de site.</small></label>
      <label>Wachtwoord <small>(minstens ${String(MIN_PASSWORD_LENGTH)} tekens)</small>
        <span class="password-field">
          <input name="new_user_pass" id="new-user-pass" type="password" required minlength="${String(MIN_PASSWORD_LENGTH)}" maxlength="200"
            autocomplete="new-password" spellcheck="false">
          <button type="button" class="secondary" data-toggle-password="new-user-pass">Tonen</button>
          <button type="button" class="secondary" data-generate-password="new-user-pass">Genereren</button>
        </span>
        <small>Gaat direct via HTTPS naar WordPress; het dashboard slaat het niet op en logt het niet. Geef het veilig door aan de gebruiker, of laat die het via "Wachtwoord vergeten" wijzigen.</small></label>
    </div>
    <div class="form-foot"><button type="submit" data-busy="Gebruiker aanmaken…">${icon('plus')} Gebruiker aanmaken</button></div>
  </form>`;
}

export function usersPage(opts: {
  csrf: string;
  scope: UserScopeView;
  users?: UserSummary[];
  roles?: RoleSummary[];
  meId?: number;
  loadError?: string;
  formError?: string;
  values?: NewUserFormValues;
}) {
  const { csrf, scope, users = [], roles = [], meId, loadError, formError, values = emptyNewUser } = opts;
  const canWrite = !scope.readOnly && !loadError;
  const list = loadError
    ? alert('error', `Gebruikers ophalen mislukt: ${loadError}`)
    : html`<div class="table-wrap"><table>
    <thead><tr><th>Gebruikersnaam</th><th>Naam</th><th>E-mail</th><th>Rol</th><th>Geregistreerd</th>${canWrite ? html`<th></th>` : null}</tr></thead>
    <tbody>${users.map(
      (u) => html`<tr>
        <td><strong>${u.username}</strong>${meId === u.id ? html` <span class="tag">koppeling dashboard</span>` : null}${(u as { super_admin?: boolean }).super_admin ? html` <span class="tag">superbeheerder</span>` : null}</td>
        <td>${u.name ?? '—'}</td>
        <td>${u.email ?? '—'}</td>
        <td>${roleNames(roles, u.roles)}</td>
        <td><small>${fmtDate(u.registered_date)}</small></td>
        ${canWrite ? html`<td class="row-actions">${meId === u.id ? html`<small>niet verwijderbaar</small>` : deleteForm(csrf, scope, u, users, meId)}</td>` : null}
      </tr>`,
    )}</tbody></table></div>`;
  return html`
${pageHead(scope.title, {
  eyebrow: scope.eyebrow,
  sub: scope.network ? 'Live opgehaald uit WordPress (multisite: gebruikers van deze site).' : 'Live opgehaald uit WordPress.',
  actions: html`${canWrite ? html`<a class="button" href="#nieuw">${icon('plus')} Nieuwe gebruiker</a>` : null}
    <a class="button secondary" href="${scope.backHref}">${scope.backLabel}</a>`,
})}
${scope.readOnly ? alert('warn', 'Deze site staat op "alleen lezen"; aanmaken en verwijderen is uitgeschakeld.') : null}
${panel({ id: 'users', title: 'Gebruikers', icon: 'users', meta: loadError ? null : `(${users.length})`, open: true, body: list })}
${canWrite
  ? panel({
      id: 'nieuw', title: 'Gebruiker aanmaken', icon: 'plus', open: Boolean(formError),
      body: html`${formError ? alert('error', formError) : null}${createForm(csrf, scope, roles, values)}`,
    })
  : null}`;
}
