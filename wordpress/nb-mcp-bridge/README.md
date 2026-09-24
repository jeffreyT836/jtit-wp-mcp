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
   shown only once — and store it as the site's `passwordEnv` secret in
   `wp-fleet-mcp`'s `config/sites.json`.
4. Confirm the site is reachable over **HTTPS**. WordPress only allows
   Application Password authentication over plain HTTP when
   `WP_ENVIRONMENT_TYPE` is `local` or `development` (see
   `wp_is_application_passwords_available()`); every other environment must
   be served over HTTPS or Application Password auth will be rejected.

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
as `{success: false, from, to: from, error: "No update available."}` rather
than being sent through the upgrader.

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
