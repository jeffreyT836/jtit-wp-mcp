# NB MCP Bridge

A single-file, dependency-free mu-plugin that adds the `nb-mcp/v1` REST
namespace consumed by the `wp-fleet-mcp` MCP server: site status, update
info/execution and role information that WordPress core REST does not
expose. Requires WordPress 6.0+ and PHP 7.4+.

## Install

1. Copy `nb-mcp-bridge.php` into `wp-content/mu-plugins/` on the target site
   (create the `mu-plugins` directory if it does not exist yet). Must-use
   plugins load automatically; there is nothing to activate.
2. Create a dedicated admin user for the MCP server, e.g. username `mcp-bot`,
   with the **Administrator** role (updates require `update_core`,
   `update_plugins`, `update_themes`, which only administrators — or network
   super admins on multisite — hold).
3. Log in as `mcp-bot`, go to **Users → Profile**, scroll to **Application
   Passwords**, enter a name (e.g. `wp-fleet-mcp`) and click **Add New
   Application Password**. Copy the generated password immediately — it is
   shown only once — and paste it into the site form of the WP Fleet dashboard
   (https://wp-dashboard.jtit.nl), where it is stored encrypted.
4. Confirm the site is reachable over **HTTPS**. WordPress only allows
   Application Password authentication over plain HTTP when
   `WP_ENVIRONMENT_TYPE` is `local` or `development` (see
   `wp_is_application_passwords_available()`); every other environment must
   be served over HTTPS or Application Password auth will be rejected.

## Safe updates (1.1.0+)

`POST /updates/plugins`, `/updates/themes` and `/updates/core` accept two
optional body fields:

| Field | Meaning |
|---|---|
| `safe: true` | Backup → update → health check → automatic restore, per item, inside the same request |
| `health_paths: ["/shop"]` | Extra site-relative pages to check (max 10, must start with a single `/`) |

How it works:

1. **Baseline**: the homepage, `wp-login.php` and the extra paths are fetched
   (loopback, with a cache-busting query arg). If the homepage already fails,
   nothing is updated (`409 nb_mcp_site_unhealthy`). Checks that already
   failed are reported as `ignored` afterwards.
2. **Backup** of the plugin/theme directory (core minor: `wp-admin`,
   `wp-includes` and root PHP files except `wp-config.php`). Stored outside the
   web root when possible (`<parent of ABSPATH>/nb-mcp-backups`), otherwise in
   `wp-content/nb-mcp-backups/<random>`; override with the
   `NB_MCP_BRIDGE_BACKUP_DIR` constant. Only items WordPress knows, whose path
   resolves inside the plugins/theme root, are ever copied.
3. **Update**, then the **health check** again, plus new `PHP Fatal error` /
   `Parse error` lines in the error log (`WP_DEBUG_LOG` or `error_log`).
4. **Failure** → the old files are put back (overwrite first, then remove files
   the update added, so the site is never left without code), the plugin is
   re-activated if it was active, and the site is checked once more.
   Success → the backup is deleted.

Why in one request: when an update makes the site fatal, the REST API is
broken too, so a later "undo" request could never arrive. The request that did
the update still runs the old code from memory.

Not covered: the **database** (a core update's DB upgrade is not reverted; the
response says so) and **major core updates** (checked and reported, never
restored automatically). Result rows gain `backup`, `health`, `rolled_back`,
and on a failed restore `rollback_error` + `backup_path` (kept for manual
recovery; a daily cron removes backups older than a day).

`GET /status` lists `features: ["safe_updates"]`; clients must check it,
because older bridges silently ignore `safe`.

End-to-end test against a real WordPress in Docker: `tests/wordpress-e2e/run.sh`.

## Caching (Kinsta, Cloudflare, other CDNs)

Since 1.0.7 every `nb-mcp/v1` response (including errors) is sent with
`Cache-Control: no-store, private` and `Vary: Authorization`, and the MCP client
adds a unique `_nbmcp` query parameter to every bridge GET. Some edge caches
(seen on Kinsta) cached authenticated bridge responses before 1.0.7 and served
them to anonymous visitors. After upgrading, **purge the site's page/edge and CDN
cache** once. To be extra safe, ask the host to exclude `/wp-json/nb-mcp/*` from
caching. Check with:

    curl -sI https://example.com/wp-json/nb-mcp/v1/updates | grep -iE 'cache-control|cf-cache-status'

An anonymous request must return `403` with `no-store`, never a cached `200`.

## Multisite

On a multisite network, the `update_core`, `update_plugins`, `update_themes`
and `update_languages` capabilities are granted only to network super
admins — this is standard WordPress behaviour and is not changed by this
plugin. Make `mcp-bot` a super admin if it needs to call the write routes on
a multisite network.

## Routes (namespace `nb-mcp/v1`)

All routes require the caller to (a) hold the listed capability and (b) have
authenticated the current request with a WordPress Application Password.
Requests that fail either check get `403 nb_mcp_forbidden`. Write routes
additionally return `409 nb_mcp_file_mods_disabled` when `DISALLOW_FILE_MODS`
is set, and `500 nb_mcp_filesystem` if direct filesystem access cannot be
initialized (see **Troubleshooting** below).

| Method | Route | Capability |
|---|---|---|
| GET | `/status` | `manage_options` |
| GET | `/updates?refresh=1` | `update_plugins` |
| POST | `/updates/plugins` `{plugins: string[]}` | `update_plugins` |
| POST | `/updates/themes` `{themes: string[]}` | `update_themes` |
| POST | `/updates/core` `{allow_major?: bool}` | `update_core` |
| POST | `/updates/translations` | `update_languages` or `update_plugins` |
| GET | `/roles?include_caps=1` | `list_users` |

See `docs/SPEC.md` §5 in the `wp-fleet-mcp` repo for the full response field
contract; the TypeScript client depends on these field names exactly.

`POST /updates/plugins` and `POST /updates/themes` check the update transient
before upgrading each item: a plugin/theme with nothing pending is reported
as `{success: false, from, to: from, error: "No update available.", no_update: true}`
rather than being sent through the upgrader.

`POST /updates/translations` does not trust the per-item result array of
`Language_Pack_Upgrader::bulk_upgrade()`: `WP_Upgrader` carries the previous
item's result over, so a failure after a success looks like a success. Instead
the bridge runs the upgrade and then checks every offered pack against the
files on disk: a pack counts as installed only when the local translation's
`PO-Revision-Date` is at least the pack's `updated` date (the same comparison
WordPress uses; for core packs the newest date across all core text domains —
`default`, `admin`, `admin-network`, `continents-cities` — is used). This does not depend on api.wordpress.org being reachable.
Afterwards the update caches are refreshed so later `GET /updates` calls are
current.
Response: `{success, count, failed, failed_items?, errors?, no_update?}`
— `success` is `true` only when `failed` is `0`; `failed_items` lists the
packs still pending; `errors` holds the upgrader skin messages. With nothing
pending the response is `{success: true, count: 0, failed: 0, no_update: true}`.

`POST /updates/core` also reports `no_update: true` alongside the existing
`{success: false, from, to, error}` shape when no core update is available,
so callers can distinguish "nothing to do" from a failed update attempt
without parsing the error string.

`GET /updates` reads core offers from the raw `update_core` site transient
rather than `get_core_updates()`, because `get_core_updates()` unconditionally
drops every offer with `response === "autoupdate"`. On a site a full major
version behind, the same-branch minor/security release is served as an
`autoupdate` offer (WordPress only proposes an `upgrade` offer for the
newest major branch), so relying on `get_core_updates()` would hide it
entirely. Each core row in the response also has a `type` field
(`"minor"` or `"major"`), computed by comparing the offer's target version
to the installed version's `x.y` branch.

`POST /updates/core` selects from the same deduplicated offer list
(preferring the site's locale, then `en_US`, then whatever is left) rather
than `find_core_update()`, since `find_core_update()` matches an offer's
`current` field — which is the offer's *target* version, not the installed
one — and would otherwise never match. With `allow_major` false (the
default), it picks the highest offer that stays within the installed
version's own `x.y` branch (e.g. the latest `7.0.x` while running `7.0.1`),
which is typically an `autoupdate` offer. It returns `409
nb_mcp_major_update_blocked` only when no same-branch offer exists but a
different-branch (major) one does; if neither exists, it reports "No core
update is available." With `allow_major` true, it picks the highest offer
across all branches.

## Filter hooks

- `nb_mcp_bridge_require_app_password` (default `true`) — return `false` to
  allow requests that only satisfy the capability check, without requiring
  Application Password authentication. Not recommended outside local testing.

## Troubleshooting

- **`nb_mcp_filesystem` (500) on a write route** — WordPress could not get
  direct filesystem access. Set `define( 'FS_METHOD', 'direct' );` in
  `wp-config.php` and make sure the web server user can write to
  `wp-content` (plugins, themes, upgrade directories).
- **`nb_mcp_file_mods_disabled` (409)** — `DISALLOW_FILE_MODS` is `true` in
  `wp-config.php`, or another plugin is blocking file modifications via the
  `file_mod_allowed` filter. This is intentional on many managed hosts.
- **Application Passwords not available over HTTP** — see step 4 above.
