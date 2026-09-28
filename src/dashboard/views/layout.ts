import { html, type SafeHtml } from './html.js';

export interface LayoutOptions {
  title: string;
  body: SafeHtml;
  /** Logged-in user email; shows the navigation when set. */
  user?: string;
  csrf?: string;
  flash?: { kind: 'ok' | 'error'; message: string };
}

export function layout({ title, body, user, csrf, flash }: LayoutOptions): string {
  return html`<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · WP Fleet</title>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head>
<body>
<header class="top">
  <a class="brand" href="/">WP Fleet</a>
  ${user
    ? html`<nav>
        <a href="/">Overzicht</a>
        <a href="/sites/new">Site toevoegen</a>
        <a href="/audit">Audit-log</a>
        <a href="/settings">Instellingen</a>
        <form method="post" action="/logout" class="inline">
          <input type="hidden" name="_csrf" value="${csrf}">
          <button type="submit" class="link">Uitloggen</button>
        </form>
      </nav>`
    : null}
</header>
<main>
  ${flash ? html`<p class="flash ${flash.kind}" role="status">${flash.message}</p>` : null}
  ${body}
</main>
</body>
</html>`.value;
}
