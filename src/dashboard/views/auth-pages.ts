import { alert } from './components.js';
import { html, trusted } from './html.js';

export function loginPage(error?: string) {
  return html`
<section class="card narrow">
  <h1>Inloggen</h1>
  <p class="hint">Beheer je WordPress-vloot vanaf één plek.</p>
  ${error ? alert('error', error) : null}
  <form method="post" action="/login" autocomplete="on">
    <label>E-mail <input type="email" name="email" required autocomplete="username" autofocus></label>
    <label>Wachtwoord <input type="password" name="password" required autocomplete="current-password"></label>
    <button type="submit">Verder</button>
  </form>
</section>`;
}

export function totpPage(csrf: string, error?: string) {
  return html`
<section class="card narrow">
  <h1>Verificatiecode</h1>
  <p>Vul de 6-cijferige code uit je authenticator-app in.</p>
  ${error ? alert('error', error) : null}
  <form method="post" action="/login/totp">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label>Code <input name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" required autocomplete="one-time-code" autofocus></label>
    <button type="submit">Inloggen</button>
  </form>
</section>`;
}

export function totpSetupPage(csrf: string, qrSvg: string, secret: string, error?: string) {
  return html`
<section class="card narrow">
  <h1>Tweestapsverificatie instellen</h1>
  <p>Scan de QR-code met je authenticator-app (bijv. 1Password, Google Authenticator) en
  bevestig met de code die de app toont. Dit is verplicht.</p>
  <div class="qr">${trusted(qrSvg)}</div>
  <details><summary>Kan niet scannen? Handmatige sleutel</summary><code class="secret">${secret}</code></details>
  ${error ? alert('error', error) : null}
  <form method="post" action="/login/totp-setup">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label>Code <input name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" required autocomplete="one-time-code" autofocus></label>
    <button type="submit">Bevestigen</button>
  </form>
</section>`;
}
