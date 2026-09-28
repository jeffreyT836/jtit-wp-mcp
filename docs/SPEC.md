# wp-fleet-mcp — Design spec (authoritative contract)

MCP server (TypeScript, Node 22+, Docker) to manage a fleet of WordPress sites via the
WP REST API, authenticated with **Application Passwords**. A small companion
**mu-plugin (`nb-mcp-bridge`)** adds endpoints that WP core REST lacks (update info,
performing updates, roles, status).

## 1. Configuration & secrets

- Sites live in a SQLite store (`SITES_DB`, default `/app/data/sites.db` in the container,
  `./data/sites.db` locally; see `src/store/site-store.ts`), managed via `node dist/cli.js
  sites list|add|remove|import` (see `src/cli.ts`). Application Passwords are stored
  AES-256-GCM encrypted (site id as AAD, see `src/store/crypto.ts`) under
  `SITES_ENCRYPTION_KEY` (base64 of 32 random bytes, required). The MCP server reloads sites
  automatically when the store's version counter changes — no restart needed.
- The legacy `config/sites.json` format (below) is no longer read at runtime. It survives only
  as the input format for the one-off `sites import` migration (`loadLegacySitesFile` in
  `src/config/loader.ts`), which resolves each site's password the old way — from
  `env[passwordEnv]` or `env[passwordEnv + "_FILE"]` — and writes it encrypted into the store.

```json
{
  "sites": [
    {
      "id": "klant-a",                     // ^[a-z0-9][a-z0-9-]{1,48}$ unique
      "name": "Klant A",
      "url": "https://www.klant-a.nl",     // must be https:// unless allowHttp:true
      "username": "mcp-bot",
      "passwordEnv": "WP_KLANT_A_APP_PASSWORD", // ^[A-Z][A-Z0-9_]+$
      "tags": ["production", "woocommerce"], // optional, default []
      "readOnly": false,                    // optional, default false
      "allowHttp": false,                   // optional, default false (local dev only)
      "bridge": true                        // optional, default true: nb-mcp-bridge installed
    }
  ]
}
```

- Secret resolution during `sites import` only: `process.env[passwordEnv]`, else read file at
  `process.env[passwordEnv + "_FILE"]` (Docker secrets). Trim whitespace; spaces inside
  application passwords are allowed (WP accepts them). At runtime, secrets come from the
  encrypted store instead (see `SiteStore.load()` in `src/store/site-store.ts`).
- Missing secret → site is loaded but marked `available: false` with reason; a warning goes
  to **stderr** (never stdout — stdout is the stdio MCP channel). Invalid legacy sites.json
  (during import) → the CLI exits non-zero without writing partial state.
- Passwords are NEVER included in tool output, errors, logs, or CLI arguments (the `sites add`
  command reads the password from a hidden terminal prompt or piped stdin). Error messages
  from fetch must be sanitized (no Authorization header, no credentials in URLs).

Global env vars:

| Var | Default | Meaning |
|---|---|---|
| `SITES_DB` | `/app/data/sites.db` (container) / `./data/sites.db` (local) | path to the SQLite site store |
| `SITES_ENCRYPTION_KEY` | — | required; base64 of 32 random bytes, encrypts stored Application Passwords |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_PORT` | `3000` | http mode port |
| `MCP_HTTP_HOST` | `0.0.0.0` | http bind |
| `MCP_HTTP_TOKEN` | — | required in http mode, min 32 chars, Bearer auth, timing-safe compare |
| `MCP_HTTP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | DNS-rebinding protection allowlist |
| `MCP_READ_ONLY` | `false` | `true` → write tools are not registered at all |
| `WP_TIMEOUT_MS` | `30000` | default request timeout |
| `WP_UPDATE_TIMEOUT_MS` | `300000` | timeout for update operations |
| `FLEET_CONCURRENCY` | `4` | max parallel sites in fleet tools |
| `AUDIT_LOG_FILE` | — | optional JSONL audit file (always also to stderr) |

## 2. Safety model

1. **Allowlist**: the server only ever talks to URLs in the site store (no user-supplied URLs → no SSRF).
2. **Write tools require `confirm: true`.** Without it they return a *dry-run preview*
   `{ dryRun: true, wouldDo: ... }` and change nothing.
3. **Per-site `readOnly`** → write tools refuse for that site with a clear error.
   **Global `MCP_READ_ONLY=true`** → write tools are not registered.
4. **Tool annotations**: set `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
5. **Audit log**: every write attempt (confirmed) → one JSON line
   `{ts, tool, site, args (redacted), ok, error?}` to stderr and `AUDIT_LOG_FILE` if set.
6. **Least privilege on WP**: recommend a dedicated `mcp-bot` administrator user per site
   (updates need admin caps), unique app password per site, revocable.
7. Container: non-root user, read-only root fs, `cap_drop: [ALL]`, `no-new-privileges`,
   http port published on `127.0.0.1` only.

## 3. Code layout (TypeScript, ESM, strict)

```
src/index.ts            entry: load config, build server, pick transport
src/server.ts           createServer(ctx): McpServer; calls registerAllTools
src/http.ts             Streamable HTTP transport + bearer auth
src/config/schema.ts    zod schemas + types (site config, legacy sites.json, env)
src/config/loader.ts    resolveSite() + loadLegacySitesFile() (used by `sites import` only)
src/store/site-store.ts SiteStore: SQLite-backed sites (list/load/upsert/remove), version counter
src/store/crypto.ts     AES-256-GCM encrypt/decrypt of Application Passwords
src/cli.ts              CLI: sites list/add/remove/import
src/wp/client.ts        WpClient: request<T>(path, {method, query, body, timeoutMs}) with
                        Basic auth, JSON, timeout (AbortSignal), error mapping, pagination helper
                        getAll<T>(path, query) using X-WP-TotalPages (cap 20 pages)
src/wp/errors.ts        WpError {status, code, message, site} sanitized
src/wp/registry.ts      SiteRegistry: list(), get(id) (throws friendly error), client(id), byTags()
src/tools/context.ts    ToolContext {registry, env, audit, readOnlyGlobal}
src/tools/helpers.ts    jsonResult(), errorResult(), requireWritable(site), confirmGuard(),
                        runFleet(sites, fn, concurrency) → per-site {site, ok, data|error}
src/tools/index.ts      registerAllTools(server, ctx) → calls every module's register()
src/tools/sites.ts      list_sites, site_check, site_info
src/tools/plugins.ts    list_plugins, activate_plugin, deactivate_plugin, install_plugin, delete_plugin
src/tools/themes.ts     list_themes
src/tools/updates.ts    list_updates, update_plugins, update_themes, update_core, update_translations
src/tools/users.ts      list_users, get_user, list_roles, create_user, update_user_roles,
                        delete_user, list_application_passwords, revoke_application_password
src/tools/content.ts    list_posts, list_comments, moderate_comment
src/tools/settings.ts   get_settings, update_settings
src/tools/fleet.ts      fleet_health, fleet_updates_report, fleet_find_plugin,
                        fleet_user_audit, fleet_update_plugin
src/audit.ts            audit logger
tests/**/*.test.ts      vitest; fetch mocked (vi.stubGlobal / injected fetch)
wordpress/nb-mcp-bridge/nb-mcp-bridge.php   mu-plugin (PHP)
```

Each `src/tools/<module>.ts` exports `register(server: McpServer, ctx: ToolContext): void`.
Write tools must be skipped when `ctx.readOnlyGlobal` is true.
Every tool that targets one site takes `site: string` (site id). Tool result = one text
content item with pretty JSON; errors → `isError: true` with a sanitized message.
Use `@modelcontextprotocol/sdk` 1.x `McpServer.registerTool(name, {title, description,
inputSchema, annotations}, handler)` with zod schemas (check the installed SDK's zod
compatibility — use `zod` v3 import path if the SDK requires it).

## 4. Tool semantics (WP REST mapping)

Core REST (`/wp-json/wp/v2/...`):
- `site_check` → `GET /wp/v2/users/me?context=edit` → `{ok, user, roles, isAdmin}` + bridge
  `GET /nb-mcp/v1/status` if `bridge` (report `bridge: "ok" | "missing" | "error"`).
- `site_info` → `GET /` (index: name, description, url, timezone_string, namespaces) + bridge status.
- `list_plugins` → `GET /wp/v2/plugins?status=&search=` → `{plugin, name, version, status, author, requires_wp, requires_php, network_only}`.
- `activate_plugin` / `deactivate_plugin` → `POST /wp/v2/plugins/<plugin>` `{status}`; plugin id is `dir/file` WITHOUT `.php` in the URL (WP route format: `akismet/akismet`).
- `install_plugin` → `POST /wp/v2/plugins {slug, status}` (wp.org slug only).
- `delete_plugin` → `DELETE /wp/v2/plugins/<plugin>`; must be inactive; destructive.
- `list_themes` → `GET /wp/v2/themes?context=edit` (or status filter).
- `list_users` → `GET /wp/v2/users?context=edit&roles=&search=` (getAll) → `{id, username, name, email, roles, registered_date}`.
- `get_user`, `create_user` (`POST /wp/v2/users`; if no password given generate 24+ char random, do NOT return it — advise password reset), `update_user_roles` (`POST /wp/v2/users/<id> {roles}`), `delete_user` (`DELETE /wp/v2/users/<id>?force=true&reassign=<id>`, reassign REQUIRED, destructive).
- `list_application_passwords` → `GET /wp/v2/users/<id>/application-passwords` (name, uuid, created, last_used, last_ip); `revoke_application_password` → `DELETE .../<uuid>`.
- `list_posts` → `GET /wp/v2/{posts|pages}?status=&search=&per_page=` (id, title, status, date, modified, link, author).
- `list_comments` → `GET /wp/v2/comments?status=hold` ; `moderate_comment` → `POST /wp/v2/comments/<id> {status: approved|hold|spam|trash}`.
- `get_settings` → `GET /wp/v2/settings`; `update_settings` → `POST /wp/v2/settings` limited to allowlist: `title, description, timezone, date_format, time_format, start_of_week, language, posts_per_page, default_comment_status`.

Bridge (`/wp-json/nb-mcp/v1/...`): if site `bridge: false` or 404 `rest_no_route` → error
"nb-mcp-bridge mu-plugin not installed on <site>".
- `list_updates {refresh?}` → `GET /updates?refresh=1`.
- `update_plugins {plugins?: string[], all?: boolean}` → `POST /updates/plugins {plugins}` (if `all`, first GET /updates and take all plugin files). Dry-run lists what would update (from → to).
- `update_themes {themes?|all}` → `POST /updates/themes`.
- `update_core {allow_major?: false}` → `POST /updates/core`.
- `update_translations` → `POST /updates/translations`.
- `list_roles {include_caps?}` → `GET /roles`.

Fleet (take optional `sites?: string[]` and `tags?: string[]` filters; default all available sites;
concurrency `FLEET_CONCURRENCY`; per-site errors never fail the whole call):
- `fleet_health` → site_check per site + versions from bridge status.
- `fleet_updates_report` → list_updates per site, summary counts + per-site details.
- `fleet_find_plugin {query}` → sites where plugin file/slug/name matches, with version/status.
- `fleet_user_audit {email?, role?="administrator"}` → per site the users matching.
- `fleet_update_plugin {plugin, confirm}` → on every matching site with an update available for that plugin, run update_plugins; skips readOnly sites (reported). Dry-run by default.

## 5. Bridge REST API contract (`nb-mcp-bridge.php`, namespace `nb-mcp/v1`)

All routes: `permission_callback` checks capability AND that the request authenticated via
an Application Password (`did_action('application_password_did_authenticate')` or
`wp_get_current_user` + `rest_get_authenticated_app_password()` non-null). Otherwise 403
`nb_mcp_forbidden`. If `DISALLOW_FILE_MODS` is true, write routes return 409 `nb_mcp_file_mods_disabled`.
Responses are JSON. Errors use WP_Error → `{code, message, data:{status}}`.

| Method | Route | Cap | Response |
|---|---|---|---|
| GET | `/status` | `manage_options` | `{bridge_version, wp_version, php_version, mysql_version, multisite, site_url, home_url, is_ssl, active_theme:{stylesheet,name,version}, constants:{WP_DEBUG, WP_DEBUG_DISPLAY, DISALLOW_FILE_EDIT, DISALLOW_FILE_MODS, WP_AUTO_UPDATE_CORE}, environment_type, memory_limit, plugin_counts:{total, active}}` |
| GET | `/updates?refresh=1` | `update_plugins` | `{checked_at, core:[{current, version, response, locale, type: "minor"|"major"}] (includes autoupdate offers), plugins:[{plugin, name, current_version, new_version, package_available, requires_php, tested, auto_update}], themes:[{stylesheet, name, current_version, new_version, package_available}], translations:{count}}` — refresh forces `wp_version_check()`, `wp_update_plugins()`, `wp_update_themes()` after clearing the site transients |
| POST | `/updates/plugins` body `{plugins: string[]}` (plugin files incl. `.php`) | `update_plugins` | `{results:[{plugin, success, from, to, error?}]}` — use `Plugin_Upgrader` + `WP_Ajax_Upgrader_Skin`, `bulk_upgrade`, preserve active state, re-activate if it was active, validate each plugin file exists in `get_plugins()` |
| POST | `/updates/themes` body `{themes: string[]}` | `update_themes` | `{results:[{theme, success, from, to, error?}]}` |
| POST | `/updates/core` body `{allow_major?: bool}` | `update_core` | `{success, from, to, error?}`; refuse major (x.Y change) unless allow_major |
| POST | `/updates/translations` | `update_languages` or `update_plugins` | `{success, count, error?}` |
| GET | `/roles?include_caps=1` | `list_users` | `{roles:[{slug, name, user_count, capabilities?}]}` |

Plugin header: `Plugin Name: NB MCP Bridge`, `Version: 1.0.0`, `Requires at least: 6.0`,
`Requires PHP: 7.4`. Single file, no dependencies, installable in `wp-content/mu-plugins/`.
