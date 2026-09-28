# wp-fleet-mcp

MCP-server (TypeScript, Node 22+, Docker) om een vloot WordPress-sites te beheren via de
WP REST API, geauthenticeerd met **Application Passwords**. Een kleine companion
mu-plugin (`nb-mcp-bridge`) voegt endpoints toe die WP core REST niet heeft (update-info,
updates uitvoeren, rollen, status).

## 1. Wat is het

`wp-fleet-mcp` is een [Model Context Protocol](https://modelcontextprotocol.io)-server die
Claude (of een andere MCP-client) laat praten met meerdere WordPress-sites tegelijk, zonder
dat Claude ooit een wachtwoord of URL zelf verzint. Elke site staat vooraf geregistreerd in
een lokale, versleutelde **SQLite-store** (beheerd met `node dist/cli.js sites ...`, zie §2.2);
de server praat alleen met die sites (allowlist, geen SSRF) en gebruikt per site een
Application Password van een dedicated `mcp-bot`-gebruiker. Voor acties die WP
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
```

Genereer een encryptiesleutel en zet die in `.env` als `SITES_ENCRYPTION_KEY` (zie §4):

```bash
openssl rand -base64 32
```

Sites worden niet meer in een JSON-bestand gezet, maar toegevoegd via de CLI. Die slaat ze op
in een lokale SQLite-store (`./data/sites.db`, of `SITES_DB`) met het Application Password
AES-256-GCM versleuteld:

```bash
SITES_ENCRYPTION_KEY=... node dist/cli.js sites add \
  --id klant-a --name "Klant A" --url https://www.klant-a.nl \
  --username mcp-bot --tags production
```

Het wachtwoord wordt hierna verborgen op het terminal gevraagd (nooit als argument). De
draaiende MCP-server merkt een wijziging in de store vanzelf op (versieteller) en herlaadt de
sites — een herstart is niet nodig na `sites add`/`remove`/`import`. Zie §2.3
voor hoe je dat Application Password aanmaakt in WordPress zelf, en §4.2 voor alle
`sites`-subcommando's (`list`, `remove`, `import`). `.env` en `data/` staan in `.gitignore` —
commit ze nooit.

### 2.3 WordPress-kant instellen (per site)

1. Maak een **dedicated admin-gebruiker** aan, bijv. `mcp-bot`, met de rol **Administrator**
   (updates vereisen `update_core`/`update_plugins`/`update_themes`, die alleen admins —
   of netwerk-super-admins op multisite — hebben).
2. Log in als `mcp-bot` → **Gebruikers → Profiel → Application Passwords** → geef een naam
   (bijv. `wp-fleet-mcp`) en klik **Add New Application Password**. Kopieer het wachtwoord
   direct — het wordt maar één keer getoond — en plak het bij de `sites add`-prompt uit §2.2.
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
  -v wp-fleet-data:/app/data \
  -v wp-fleet-logs:/app/logs \
  wp-fleet-mcp
```

Gebruik altijd een **absoluut pad** voor `--env-file`. `SITES_ENCRYPTION_KEY` moet in dat
`.env` staan. De `wp-fleet-data`-volume bevat de SQLite site-store (zie §2.2/§4.1); zonder die
volume ben je na elke `docker run` je sites kwijt. `-v wp-fleet-logs:/app/logs` is alleen nodig
als je `AUDIT_LOG_FILE` gebruikt (zie §4.2) — de container draait met een read-only root
filesystem, dus zonder deze (of een andere) volume op `/app/logs` kan het audit-bestand niet
weggeschreven worden.

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
        "-v", "wp-fleet-data:/app/data",
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
(timing-safe vergeleken). `MCP_HTTP_ALLOWED_HOSTS` beschermt tegen DNS-rebinding: de server
vergelijkt de binnenkomende `Host`-header exact tegen deze lijst.

**`MCP_HTTP_ALLOWED_HOSTS` en poorten.** Een "kale" entry zonder `:poort` (bijv. `localhost`)
wordt automatisch ook geaccepteerd als `<entry>:<MCP_HTTP_PORT>`, omdat dat de `Host`-header
is die een normale request stuurt (bijv. `localhost:3000` als `MCP_HTTP_PORT=3000`). Zonder
die uitbreiding zou elke gewone request met `Invalid Host header` geweigerd worden. Een entry
die zelf al een poort bevat (bijv. `example.com:8443`) wordt ongewijzigd gebruikt.

`MCP_HTTP_PORT` is echter de poort **in de container**, niet per se de poort waarmee een
client verbindt. Map je de host-poort anders (`docker run -p 127.0.0.1:3399:3000`, of een
reverse proxy), dan ziet de container een `Host`-header met die externe poort (bijv.
`localhost:3399`) — die kan niet automatisch afgeleid worden uit `MCP_HTTP_PORT=3000`. Zet in
dat geval de externe host:poort-combinatie expliciet in `MCP_HTTP_ALLOWED_HOSTS`, bijv.:

```bash
docker run -d --rm \
  --env-file .env \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_ALLOWED_HOSTS=localhost:3399,127.0.0.1:3399 \
  -v wp-fleet-data:/app/data \
  -p 127.0.0.1:3399:3000 \
  wp-fleet-mcp
```

Poort al in gebruik op je machine via `docker compose`? Pas de host-poort in de
`ports:`-mapping aan, bijv. `"127.0.0.1:3001:3000"` (de container-poort 3000 hoeft niet te
veranderen) — en werk `MCP_HTTP_ALLOWED_HOSTS` in dezelfde service dan bij naar
`localhost:3001,127.0.0.1:3001`, net als in het `docker run`-voorbeeld hierboven.

## 4. Configuratie

### 4.1 Sites-store (CLI)

Sites staan in een SQLite-store (`SITES_DB`, standaard `/app/data/sites.db` in de container,
`./data/sites.db` lokaal), niet meer in een JSON-bestand. Beheer ze met `node dist/cli.js
sites <command>`:

```
sites list
sites add --id <id> --name <naam> --url <https://...> [--username mcp-bot]
          [--tags a,b] [--read-only] [--allow-http] [--no-bridge] [--keep-password]
sites remove --id <id>
sites import --file <sites.json>
```

`add` vraagt het Application Password verborgen op het terminal (of leest het van stdin als
dat gepiped wordt) — nooit als argument, zodat het niet in shell-historie of `ps` terechtkomt.
`--keep-password` update een site zonder het wachtwoord te wijzigen. In Docker:

```bash
docker compose exec -it wp-mcp node dist/cli.js sites add --id klant-a --name "Klant A" --url https://www.klant-a.nl
```

| Veld | Verplicht | Standaard | Betekenis |
|---|---|---|---|
| `id` | ja | — | Uniek, `^[a-z0-9][a-z0-9-]{1,48}$` |
| `name` | ja (of gelijk aan `id`) | — | Weergavenaam |
| `url` | ja | — | Basis-URL; moet `https://` zijn tenzij `allowHttp: true` |
| `username` | nee | `mcp-bot` | WP-gebruikersnaam |
| `tags` | nee | `[]` | Vrije labels, gebruikt door fleet-tools' `tags`-filter |
| `readOnly` | nee | `false` | Weigert write-tools voor deze site |
| `allowHttp` | nee | `false` | Staat `http://` toe (alleen lokale dev) |
| `bridge` | nee | `true` | Of `nb-mcp-bridge` op deze site geïnstalleerd is |

**Migreren vanaf een oude `sites.json` + `.env`:** `sites import` is precies daarvoor bedoeld
— eenmalig, met de oude `WP_*_APP_PASSWORD`-vars nog in de omgeving:

```bash
SITES_ENCRYPTION_KEY=... SITES_DB=./data/sites.db node dist/cli.js sites import --file config/sites.json
```

In Docker doe je hetzelfde op de server (`docker compose exec -T wp-mcp node dist/cli.js sites
import --file /pad/naar/sites.json`, met de `WP_*`-env-vars gezet), of lokaal met `SITES_DB`
naar het doelbestand en de resulterende `sites.db` daarna naar de container kopiëren.

### 4.2 Environment-variabelen

| Var | Standaard | Betekenis |
|---|---|---|
| `SITES_DB` | `/app/data/sites.db` (container) / `./data/sites.db` (lokaal) | Pad naar de SQLite site-store |
| `SITES_ENCRYPTION_KEY` | — | **Verplicht.** Base64 van 32 random bytes (`openssl rand -base64 32`); versleutelt Application Passwords (AES-256-GCM) in de store |
| `MCP_TRANSPORT` | `stdio` | `stdio` of `http` |
| `MCP_HTTP_PORT` | `3000` | Poort in http-modus |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind-adres in http-modus |
| `MCP_HTTP_TOKEN` | — | Verplicht in http-modus, min. 32 tekens, Bearer-auth |
| `MCP_HTTP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Allowlist tegen DNS-rebinding; elke entry telt ook als `entry:MCP_HTTP_PORT` (zie §3.3 voor Docker-poortmapping) |
| `MCP_READ_ONLY` | `false` | `true` → write-tools worden niet geregistreerd |
| `WP_TIMEOUT_MS` | `30000` | Timeout voor gewone requests |
| `WP_UPDATE_TIMEOUT_MS` | `300000` | Timeout voor update-operaties |
| `FLEET_CONCURRENCY` | `4` | Max. gelijktijdige sites in fleet-tools |
| `AUDIT_LOG_FILE` | — | Optioneel pad naar JSONL audit-bestand — moet in Docker naar een writable volume wijzen (zie `docker-compose.yml`'s `wp-fleet-logs` volume op `/app/logs`, of `-v wp-fleet-logs:/app/logs` bij een losse `docker run`), anders faalt het schrijven op de read-only rootfs |

### 4.3 Secrets

Elk Application Password ligt AES-256-GCM versleuteld in de SQLite-store, met de site-id als
AAD (zo faalt een ciphertext die per ongeluk op een andere site's rij terechtkomt bij het
decrypten in plaats van stilletjes het verkeerde wachtwoord op te leveren). Ontbreekt het
wachtwoord (nog niet gezet, of decryptie mislukt door een verkeerde
`SITES_ENCRYPTION_KEY`), dan blijft de site geladen maar met `available: false` en een reden
(waarschuwing naar stderr, nooit stdout — dat is het stdio MCP-kanaal). Wachtwoorden komen
nooit in tool-output, foutmeldingen, logs of CLI-argumenten terecht.

`SITES_ENCRYPTION_KEY` is de enige sleutel tot alle opgeslagen wachtwoorden: bewaar hem in een
password manager. Raak je hem kwijt, dan is er geen recovery — voeg elke site opnieuw toe met
een vers Application Password.

## 5. Productie (Hostinger)

De productie-server draait via GitHub Actions, twee workflows in `.github/workflows/`:

- **`ci.yml`** — lint, tests (met coverage-drempel) en build; draait op elke pull request, en
  wordt door `deploy.yml` aangeroepen vóórdat er iets gedeployed wordt.
- **`deploy.yml`** — bij elke push naar `main`: eerst `ci.yml`, dan bouwt en pusht hij de
  Docker-image naar `ghcr.io/jeffreyt836/jtit-wp-mcp`, kopieert `docker-compose.prod.yml` via
  scp naar `/docker/jtit-wp-mcp` op de server, en logt via SSH in om `docker compose pull` +
  `up -d` te draaien en te wachten tot de container `healthy` is (health-check op
  `/healthz`).

Bij de **eerste** deploy genereert het script zelf een `.env` in `/docker/jtit-wp-mcp` met een
willekeurige `MCP_HTTP_TOKEN` en `SITES_ENCRYPTION_KEY`; daarna wordt die `.env` nooit meer
overschreven (een nieuwe `SITES_ENCRYPTION_KEY` zou alle opgeslagen wachtwoorden onleesbaar
maken). Kopieer na die eerste deploy **beide waarden uit de server-`.env`** naar een password
manager — zonder `SITES_ENCRYPTION_KEY` moet je alle Application Passwords opnieuw genereren.

De server draait achter **Traefik** en is bereikbaar op `https://wp-mcp.jtit.nl/mcp`
(bearer-token-auth, rate limiting via Traefik-middleware — zie `docker-compose.prod.yml`).

**Vereisten om te deployen:**

- Een GitHub-**environment** genaamd `Hostinger` met secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY`.
- Een DNS A-record `wp-mcp.jtit.nl` → het VPS-IP.
- Een extern `traefik-network` Docker-netwerk op de server (de deploy faalt expliciet als dat
  ontbreekt).

Sites beheer je op de server net als lokaal, via de CLI in de draaiende container:

```bash
docker compose exec wp-mcp node dist/cli.js sites list
docker compose exec -it wp-mcp node dist/cli.js sites add --id klant-a --name "Klant A" --url https://klant-a.nl
```

Claude Code verbinden met de productie-server:

```bash
claude mcp add --transport http wp-fleet https://wp-mcp.jtit.nl/mcp --header "Authorization: Bearer <token>"
```

## 6. Beveiligingsmodel

1. **Allowlist, geen SSRF** — de server praat uitsluitend met URL's uit de site-store; er is
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

## 7. Tools overzicht

Alle tools nemen `site: string` (site-id uit de site-store) tenzij anders vermeld. Write-tools
vereisen `confirm: true` om echt uit te voeren; zonder `confirm` volgt een dry-run preview.

### Sites

| Tool | Wat | R/W | Bridge |
|---|---|---|---|
| `list_sites` | Lijst alle sites uit de site-store (id, name, url, tags, readOnly, bridge, available); optioneel filter op `tags` | R | nee |
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

## 8. Voorbeeldprompts

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

## 9. Ontwikkeling

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
src/cli.ts              CLI: sites list/add/remove/import (node dist/cli.js)
src/server.ts           createServer(ctx) — registreert alle tools
src/http.ts             Streamable HTTP transport + bearer-auth
src/audit.ts            audit-logger (stderr + optioneel AUDIT_LOG_FILE)
src/config/schema.ts    zod-schemas + types (site config, legacy sites.json, env)
src/config/loader.ts    resolveSite() + loadLegacySitesFile() (voor `sites import`)
src/store/site-store.ts SiteStore — SQLite-backed sites (list/load/upsert/remove), versieteller
src/store/crypto.ts     AES-256-GCM encrypt/decrypt van Application Passwords
src/wp/client.ts        WpClient — REST-requests, timeouts, paginatie, bridge-calls
src/wp/errors.ts        WpError + sanitatie van foutmeldingen
src/wp/registry.ts      SiteRegistry — list/get/client/byTags per site, herlaadt bij store-wijziging
src/tools/*.ts          één module per toolgroep (sites, plugins, themes, updates, users,
                         content, settings, fleet) + helpers.ts, context.ts, index.ts
tests/**/*.test.ts      vitest, met gemockte fetch
wordpress/nb-mcp-bridge/nb-mcp-bridge.php   de mu-plugin
```

Tests staan onder `tests/tools/` (per toolmodule) en `tests/core/` (client, loader, store, cli,
helpers); `tests/helpers/harness.ts` bevat gedeelde testopzet.

## 10. Dashboard (gepland)

Er komt een webdashboard op `wp-dashboard.jtit.nl`, in dezelfde repo als een monorepo
(`apps/mcp`, `apps/dashboard`, `packages/site-store`). Het dashboard en de MCP-server delen
dezelfde versleutelde SQLite-store: het dashboard schrijft sites en wachtwoorden, de
MCP-server leest ze alleen (wachtwoordvelden in het dashboard zijn write-only — nooit
teruggelezen of getoond). Toegang tot het dashboard vereist een sterke login (passkey/TOTP, of
Traefik forward-auth).

Belangrijk: de encryptie beschermt tegen het lekken van de database of een backup, niet tegen
een gecompromitteerde VPS zelf (die kan de sleutel uit een draaiend proces lezen). Blijf dus
ook aan de WP-kant least-privilege toepassen (dedicated `mcp-bot`-gebruiker, geen extra
rechten) en Application Passwords intrekbaar/roteerbaar houden.

## 11. Ideeën / roadmap

Nog niet geïmplementeerd — kandidaten voor een volgende iteratie:

- Backup-status check (bevestigen dat een backup-plugin/dienst recent gedraaid heeft).
- Uptime- en SSL-certificaat-vervaldatum-check per site.
- WooCommerce-statusoverzicht (bestellingen, voorraadwaarschuwingen).
- WordPress Site Health-tests via de bridge ontsluiten.
- Geplande/periodieke rapporten (bijv. wekelijks update- en healthrapport per mail/Slack).
- Integratie met SatisPress voor privé-pluginversies binnen de vloot.
