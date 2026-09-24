# wp-fleet-mcp

MCP-server (TypeScript, Node 22+, Docker) om een vloot WordPress-sites te beheren via de
WP REST API, geauthenticeerd met **Application Passwords**. Een kleine companion
mu-plugin (`nb-mcp-bridge`) voegt endpoints toe die WP core REST niet heeft (update-info,
updates uitvoeren, rollen, status).

## 1. Wat is het

`wp-fleet-mcp` is een [Model Context Protocol](https://modelcontextprotocol.io)-server die
Claude (of een andere MCP-client) laat praten met meerdere WordPress-sites tegelijk, zonder
dat Claude ooit een wachtwoord of URL zelf verzint. Elke site staat vooraf gedefinieerd in
`config/sites.json`; de server praat alleen met die sites (allowlist, geen SSRF) en gebruikt
per site een Application Password van een dedicated `mcp-bot`-gebruiker. Voor acties die WP
core REST niet ondersteunt (updates uitvoeren, rollen opvragen, serverstatus) roept de server
de `nb-mcp-bridge` mu-plugin aan, die je los op elke site installeert. De server draait als
Docker-container en praat met de client via `stdio` (lokaal, bijv. Claude Code/Desktop) of
`http` (bearer-token, voor een langlevende service).

```
                stdio of HTTP (bearer)
  Claude  <───────────────────────────►  wp-fleet-mcp (Docker container)
                                               │
                                               │  HTTPS + Application Password
                                               ▼
                                     WordPress REST API (/wp-json/wp/v2/...)
                                               │
                                               ▼
                                     nb-mcp-bridge mu-plugin (/wp-json/nb-mcp/v1/...)
                                     (updates, rollen, status — core REST mist dit)
```

## 2. Snel starten

### 2.1 Image bouwen

```bash
docker build -t wp-fleet-mcp .
```

### 2.2 Config en secrets voorbereiden

```bash
cp .env.example .env
cp config/sites.example.json config/sites.json
```

Vul `.env` met per site een `WP_<SITE>_APP_PASSWORD` (zie §4) en pas `config/sites.json` aan
met de echte site-ids, URL's en `passwordEnv`-namen. `config/sites.json` en `.env` staan in
`.gitignore` — commit ze nooit.

### 2.3 WordPress-kant instellen (per site)

1. Maak een **dedicated admin-gebruiker** aan, bijv. `mcp-bot`, met de rol **Administrator**
   (updates vereisen `update_core`/`update_plugins`/`update_themes`, die alleen admins —
   of netwerk-super-admins op multisite — hebben).
2. Log in als `mcp-bot` → **Gebruikers → Profiel → Application Passwords** → geef een naam
   (bijv. `wp-fleet-mcp`) en klik **Add New Application Password**. Kopieer het wachtwoord
   direct — het wordt maar één keer getoond — en zet het in `.env` als de site's
   `passwordEnv`-waarde.
3. Installeer de bridge-mu-plugin: kopieer `wordpress/nb-mcp-bridge/nb-mcp-bridge.php` naar
   `wp-content/mu-plugins/` op de site. Volledige installatie-instructies en troubleshooting:
   [`wordpress/nb-mcp-bridge/README.md`](wordpress/nb-mcp-bridge/README.md).
4. Zorg dat de site over **HTTPS** bereikbaar is — Application Passwords werken alleen over
   HTTP als `WP_ENVIRONMENT_TYPE` `local`/`development` is.

### 2.4 Eerste keer starten: read-only

Start de eerste keer altijd met `MCP_READ_ONLY=true` in `.env`, zodat write-tools niet eens
geregistreerd worden. Test met `list_sites` en `site_check` per site, en zet pas daarna
`MCP_READ_ONLY=false` als alles klopt.

## 3. Koppelen aan Claude

### 3.1 Claude Code (stdio, via Docker)

```bash
claude mcp add wp-fleet -s user -- docker run -i --rm \
  --env-file /absoluut/pad/naar/.env \
  -v /absoluut/pad/naar/config/sites.json:/app/config/sites.json:ro \
  wp-fleet-mcp
```

Gebruik altijd **absolute paden** voor `--env-file` en de volume-mount.

### 3.2 Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wp-fleet": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/absoluut/pad/naar/.env",
        "-v", "/absoluut/pad/naar/config/sites.json:/app/config/sites.json:ro",
        "wp-fleet-mcp"
      ]
    }
  }
}
```

### 3.3 HTTP-modus (langlevende service)

Voor een client die Streamable HTTP over localhost spreekt:

```bash
docker compose --profile http up -d mcp-http
```

Dit start de `mcp-http`-service uit `docker-compose.yml`: gebonden aan `127.0.0.1:3000`,
`read_only` rootfs, `cap_drop: [ALL]`, `no-new-privileges`. Vereist `MCP_HTTP_TOKEN` (min. 32
tekens) in `.env`; elke request moet `Authorization: Bearer <token>` meesturen
(timing-safe vergeleken). `MCP_HTTP_ALLOWED_HOSTS` beschermt tegen DNS-rebinding.

Poort al in gebruik op je machine? Pas de host-poort in de `ports:`-mapping aan, bijv.
`"127.0.0.1:3001:3000"` (de container-poort 3000 hoeft niet te veranderen).

## 4. Configuratie

### 4.1 `config/sites.json`

| Veld | Verplicht | Standaard | Betekenis |
|---|---|---|---|
| `id` | ja | — | Uniek, `^[a-z0-9][a-z0-9-]{1,48}$` |
| `name` | ja | — | Weergavenaam |
| `url` | ja | — | Basis-URL; moet `https://` zijn tenzij `allowHttp: true` |
| `username` | ja | — | WP-gebruikersnaam (de `mcp-bot`) |
| `passwordEnv` | ja | — | Naam van de env var met het Application Password, `^[A-Z][A-Z0-9_]+$` |
| `tags` | nee | `[]` | Vrije labels, gebruikt door fleet-tools' `tags`-filter |
| `readOnly` | nee | `false` | Weigert write-tools voor deze site |
| `allowHttp` | nee | `false` | Staat `http://` toe (alleen lokale dev) |
| `bridge` | nee | `true` | Of `nb-mcp-bridge` op deze site geïnstalleerd is |

`sites.json` wordt gevalideerd met zod bij het opstarten; een ongeldig bestand stopt de
server (exit 1).

### 4.2 Environment-variabelen

| Var | Standaard | Betekenis |
|---|---|---|
| `SITES_CONFIG` | `/app/config/sites.json` | Pad naar sites.json |
| `MCP_TRANSPORT` | `stdio` | `stdio` of `http` |
| `MCP_HTTP_PORT` | `3000` | Poort in http-modus |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind-adres in http-modus |
| `MCP_HTTP_TOKEN` | — | Verplicht in http-modus, min. 32 tekens, Bearer-auth |
| `MCP_HTTP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Allowlist tegen DNS-rebinding |
| `MCP_READ_ONLY` | `false` | `true` → write-tools worden niet geregistreerd |
| `WP_TIMEOUT_MS` | `30000` | Timeout voor gewone requests |
| `WP_UPDATE_TIMEOUT_MS` | `300000` | Timeout voor update-operaties |
| `FLEET_CONCURRENCY` | `4` | Max. gelijktijdige sites in fleet-tools |
| `AUDIT_LOG_FILE` | — | Optioneel pad naar JSONL audit-bestand |

### 4.3 Secrets

Per site zoekt de server eerst `process.env[passwordEnv]`; is die leeg, dan leest hij het
bestand op `process.env[passwordEnv + "_FILE"]` (Docker secrets-patroon, zie
`WP_KLANT_A_APP_PASSWORD_FILE` in `.env.example`). Ontbreekt beide, dan blijft de site
geladen maar met `available: false` en een reden (waarschuwing naar stderr, nooit stdout —
dat is het stdio MCP-kanaal). Wachtwoorden komen nooit in tool-output, foutmeldingen of logs
terecht.

`sites.json` staat los van de secrets omdat het **geen** geheime data bevat (site-ids, URL's,
tags, feature-vlaggen) en dus prima meegecommit of gedeeld kan worden binnen het team, terwijl
alleen `.env` (of Docker secrets) de wachtwoorden bevat en strikt privé blijft.

## 5. Beveiligingsmodel

1. **Allowlist, geen SSRF** — de server praat uitsluitend met URL's uit `sites.json`; er is
   geen tool die een vrije, door de gebruiker opgegeven URL aanroept.
2. **Write-tools vereisen `confirm: true`.** Zonder `confirm` geven ze een dry-run preview
   terug (`{ dryRun: true, wouldDo: ... }`) en veranderen ze niets.
3. **Read-only per site en globaal** — `readOnly: true` op een site weigert write-tools voor
   die site met een duidelijke foutmelding; `MCP_READ_ONLY=true` registreert write-tools
   helemaal niet.
4. **Tool-annotaties** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
   op elke tool, zodat MCP-clients gevaarlijke acties kunnen herkennen.
5. **Audit log** — elke *bevestigde* write-poging wordt als één JSON-regel
   (`{ts, tool, site, args (geredigeerd), ok, error?}`) naar stderr geschreven, en ook naar
   `AUDIT_LOG_FILE` als die gezet is. Wachtwoorden/tokens worden altijd geredigeerd.
6. **Bridge vereist Application Password-auth** — elke `nb-mcp/v1`-route controleert zowel de
   WP-capability als dat de request via een Application Password is geauthenticeerd; anders
   `403 nb_mcp_forbidden`.
7. **Container hardening** — non-root user, read-only root filesystem, `cap_drop: [ALL]`,
   `no-new-privileges`, http-poort alleen op `127.0.0.1` gepubliceerd (zie
   `docker-compose.yml`).
8. **Rotatie/intrekken** — gebruik per site een uniek Application Password; bij vermoeden van
   lekkage direct intrekken via `revoke_application_password` (of in WP Admin) en een nieuwe
   genereren. Controleer regelmatig `list_application_passwords` op oude/onbekende entries.
9. **HTTPS verplicht** — Application Password-auth werkt alleen over HTTP wanneer
   `WP_ENVIRONMENT_TYPE` `local`/`development` is; elke andere omgeving moet HTTPS zijn.

## 6. Tools overzicht

Alle tools nemen `site: string` (site-id uit `sites.json`) tenzij anders vermeld. Write-tools
vereisen `confirm: true` om echt uit te voeren; zonder `confirm` volgt een dry-run preview.

### Sites

| Tool | Wat | R/W | Bridge |
|---|---|---|---|
| `list_sites` | Lijst alle sites uit sites.json (id, name, url, tags, readOnly, bridge, available); optioneel filter op `tags` | R | nee |
| `site_check` | Connectiviteit/auth-check: huidige user, roles, bridge-status | R | optioneel |
| `site_info` | WP REST-index (name, description, url, timezone, namespaces) + bridge-status | R | optioneel |

### Plugins

| Tool | Wat | R/W | Bridge |
|---|---|---|---|
| `list_plugins` | Geïnstalleerde plugins met status/versie/auteur; filter op `status`/`search` | R | nee |
| `activate_plugin` | Activeert een plugin (`plugin`: `dir/file`) | W | nee |
| `deactivate_plugin` | Deactiveert een plugin | W | nee |
| `install_plugin` | Installeert een plugin vanaf WordPress.org op `slug` | W | nee |
| `delete_plugin` | Verwijdert een gedeactiveerde plugin permanent (destructief) | W | nee |

### Thema's

| Tool | Wat | R/W | Bridge |
|---|---|---|---|
| `list_themes` | Geïnstalleerde thema's met status/versie; filter op `status`/`search` | R | nee |

### Updates (bridge)

| Tool | Wat | R/W | Bridge |
|---|---|---|---|
| `list_updates` | Beschikbare core/plugin/theme/translation-updates; `refresh:true` forceert verse check | R | **ja** |
| `update_plugins` | Update plugins (`plugins: string[]` of `all: true`) | W | **ja** |
| `update_themes` | Update thema's (`themes: string[]` of `all: true`) | W | **ja** |
| `update_core` | Update WordPress core; `allow_major` staat majorversie toe (default alleen minor/security) | W | **ja** |
| `update_translations` | Update vertaalbestanden voor core/plugins/thema's | W | **ja** |

### Gebruikers

| Tool | Wat | R/W | Bridge |
|---|---|---|---|
| `list_users` | Gebruikers als `{id, username, name, email, roles, registered_date}`; filter op `roles`/`search` | R | nee |
| `get_user` | Eén gebruiker op `id` | R | nee |
| `list_roles` | Rollen op de site (slug, name, user_count, optioneel `include_caps`) | R | **ja** |
| `create_user` | Nieuwe gebruiker aanmaken; zonder `password` wordt er één gegenereerd (nooit teruggegeven — reset-mail sturen) | W | nee |
| `update_user_roles` | Vervangt rollen van een gebruiker (`roles: string[]`); weigert de eigen `mcp-bot`-admin-rol weg te halen (lockout-guard) | W | nee |
| `delete_user` | Verwijdert een gebruiker permanent; `reassign` verplicht, mag niet gelijk zijn aan `id`; weigert eigen account (destructief) | W | nee |
| `list_application_passwords` | Application passwords van een gebruiker (`uuid, name, created, last_used, last_ip` — nooit de waarde zelf) | R | nee |
| `revoke_application_password` | Trekt één Application Password in op `uuid` (destructief, direct effect) | W | nee |

### Content

| Tool | Wat | R/W | Bridge |
|---|---|---|---|
| `list_posts` | Posts/pages (`type`, `status`, `search`, `per_page`) | R | nee |
| `list_comments` | Reacties (default `status: hold`), content als HTML-vrije excerpt (max 300 tekens) | R | nee |
| `moderate_comment` | Zet reactiestatus (`approved`/`hold`/`spam`/`trash`) | W | nee |

### Instellingen

| Tool | Wat | R/W | Bridge |
|---|---|---|---|
| `get_settings` | Algemene site-instellingen | R | nee |
| `update_settings` | Wijzigt alleen allowlisted velden: `title, description, timezone, date_format, time_format, start_of_week, language, posts_per_page, default_comment_status` | W | nee |

### Fleet

| Tool | Wat | R/W | Bridge |
|---|---|---|---|
| `fleet_health` | Health-check over de hele vloot (auth, roles, bridge + WP/PHP-versies); filter `sites`/`tags` | R | optioneel |
| `fleet_updates_report` | Update-rapport over de hele vloot met totalen + per-site details | R | **ja** |
| `fleet_find_plugin` | Zoekt een plugin (bestand/slug/naam, case-insensitive) over de hele vloot | R | nee |
| `fleet_user_audit` | Gebruikers per rol (default `administrator`), optioneel gefilterd op e-mail, over de hele vloot | R | nee |
| `fleet_update_plugin` | Update één plugin op elke site met een beschikbare update; slaat `readOnly`-sites over (gerapporteerd) | W | **ja** |

Fleet-tools nemen optioneel `sites?: string[]` en `tags?: string[]` (default: alle
beschikbare sites); concurrency via `FLEET_CONCURRENCY`. Fouten op één site laten de rest van
de call nooit falen.

## 7. Voorbeeldprompts

- "Geef me een `fleet_health`-overzicht van alle sites met tag `production`."
- "Welke plugin-updates staan er klaar over de hele vloot? Maak een `fleet_updates_report`."
- "Update Akismet naar de laatste versie op alle sites waar een update beschikbaar is, maar laat het eerst als dry-run zien."
- "Zoek op welke sites WooCommerce actief is met `fleet_find_plugin`."
- "Doe een admin-audit: welke gebruikers hebben de rol `administrator` op elke site?"
- "Controleer op `klant-a` of er application passwords zijn die al maanden niet gebruikt zijn (`list_application_passwords`)."
- "Maak een wekelijks update-rapport: core, plugins en thema's per site, met from/to-versies."
- "Update WordPress core op `klant-b`, maar sta geen majorversie toe."
- "Zet reactie 12345 op `klant-a` op spam."
- "Welke posts staan er nog als concept op `klant-c`?"
- "Wijzig de posts-per-page instelling op `klant-a` naar 12 (laat eerst zien wat er verandert)."
- "Controleer of de `nb-mcp-bridge` overal correct geïnstalleerd is met `site_check`."
- "Deactiveer en verwijder plugin X op `klant-b`, met bevestiging."
- "Geef een overzicht van alle geconfigureerde sites en welke read-only staan."
- "Maak een nieuwe editor-gebruiker aan op `klant-a` en stuur geen wachtwoord mee."

## 8. Ontwikkeling

### npm scripts

| Script | Doet |
|---|---|
| `npm run build` | `tsc -p tsconfig.json` → compileert naar `dist/` |
| `npm start` | Start de gebouwde server (`node dist/index.js`) |
| `npm run dev` | `tsc --watch` |
| `npm test` | `vitest run` |
| `npm run test:coverage` | `vitest run --coverage` |
| `npm run lint` | `tsc --noEmit` |

### Projectstructuur

```
src/index.ts            entrypoint: config laden, server bouwen, transport kiezen
src/server.ts           createServer(ctx) — registreert alle tools
src/http.ts             Streamable HTTP transport + bearer-auth
src/audit.ts            audit-logger (stderr + optioneel AUDIT_LOG_FILE)
src/config/schema.ts    zod-schemas + types (sites.json, env)
src/config/loader.ts    laadt en valideert config, lost secrets op
src/wp/client.ts        WpClient — REST-requests, timeouts, paginatie, bridge-calls
src/wp/errors.ts        WpError + sanitatie van foutmeldingen
src/wp/registry.ts      SiteRegistry — list/get/client/byTags per site
src/tools/*.ts          één module per toolgroep (sites, plugins, themes, updates, users,
                         content, settings, fleet) + helpers.ts, context.ts, index.ts
tests/**/*.test.ts      vitest, met gemockte fetch
wordpress/nb-mcp-bridge/nb-mcp-bridge.php   de mu-plugin
```

Tests staan onder `tests/tools/` (per toolmodule) en `tests/core/` (client, loader, sites,
helpers); `tests/helpers/harness.ts` bevat gedeelde testopzet.

## 9. Ideeën / roadmap

Nog niet geïmplementeerd — kandidaten voor een volgende iteratie:

- Backup-status check (bevestigen dat een backup-plugin/dienst recent gedraaid heeft).
- Uptime- en SSL-certificaat-vervaldatum-check per site.
- WooCommerce-statusoverzicht (bestellingen, voorraadwaarschuwingen).
- WordPress Site Health-tests via de bridge ontsluiten.
- Geplande/periodieke rapporten (bijv. wekelijks update- en healthrapport per mail/Slack).
- Integratie met SatisPress voor privé-pluginversies binnen de vloot.
