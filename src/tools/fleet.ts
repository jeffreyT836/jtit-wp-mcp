import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResolvedSite } from '../config/schema.js';
import { WpError, sanitizeMessage } from '../wp/errors.js';
import type { WpClient } from '../wp/client.js';
import type { ToolContext } from './context.js';
import { errorResult, jsonResult, requireWritable, runFleet, selectSites } from './helpers.js';
import { fetchPlugins, validatePluginId } from './plugins.js';
import { fetchBridgeUpdates, stripPhp } from './updates.js';

const siteFilterSchema = {
  sites: z.array(z.string()).optional().describe('Restrict to these site ids (default: every available site)'),
  tags: z.array(z.string()).optional().describe('Restrict to sites carrying all of these tags'),
};

interface WpUserMe {
  id: number;
  username?: string;
  slug?: string;
  roles?: string[];
}

interface BridgeStatusInfo {
  bridge_version?: string;
  wp_version?: string;
  php_version?: string;
}

type BridgeState = 'ok' | 'missing' | 'error' | 'disabled';

interface FleetHealth {
  ok: boolean;
  user?: { id: number; username: string };
  roles: string[];
  bridge: BridgeState;
  versions?: BridgeStatusInfo;
  error?: string;
}

async function fleetHealthForSite(client: WpClient, site: ResolvedSite): Promise<FleetHealth> {
  let ok = false;
  let user: { id: number; username: string } | undefined;
  let roles: string[] = [];
  let error: string | undefined;

  try {
    const me = await client.request<WpUserMe>('/wp/v2/users/me', { query: { context: 'edit' } });
    ok = true;
    roles = me.roles ?? [];
    user = { id: me.id, username: me.username ?? me.slug ?? '' };
  } catch (err) {
    error = err instanceof WpError ? err.message : sanitizeMessage(err instanceof Error ? err.message : String(err));
  }

  let bridge: BridgeState = 'disabled';
  let versions: BridgeStatusInfo | undefined;
  if (site.bridge !== false) {
    try {
      versions = await client.bridge<BridgeStatusInfo>('/status');
      bridge = 'ok';
    } catch (err) {
      bridge = err instanceof WpError && err.code === 'nb_mcp_bridge_missing' ? 'missing' : 'error';
    }
  }

  return { ok, user, roles, bridge, ...(versions ? { versions } : {}), ...(error ? { error } : {}) };
}

interface WpUser {
  id: number;
  username?: string;
  slug?: string;
  email?: string;
  roles?: string[];
}

interface AuditedUser {
  id: number;
  username: string;
  email?: string;
  roles: string[];
}

async function fetchUsersForAudit(client: WpClient, role: string, email?: string): Promise<AuditedUser[]> {
  const users = await client.getAll<WpUser>('/wp/v2/users', { context: 'edit', roles: role });
  const filtered = email
    ? users.filter((u) => (u.email ?? '').toLowerCase() === email.toLowerCase())
    : users;
  return filtered.map((u) => ({ id: u.id, username: u.username ?? u.slug ?? '', email: u.email, roles: u.roles ?? [] }));
}

/** Registers `fleet_health`, `fleet_updates_report`, `fleet_find_plugin`, `fleet_user_audit`, `fleet_update_plugin`. See SPEC.md §4. */
export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'fleet_health',
    {
      title: 'Fleet health check',
      description:
        'Runs a connectivity/health check across the fleet: authenticated user + roles + nb-mcp-bridge status (with WP/PHP/bridge versions when reachable) for each site. Filter with sites (site ids) and/or tags (all tags must match); defaults to every available site. Per-site errors never fail the whole call. Read-only.',
      inputSchema: siteFilterSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sites, tags }) => {
      try {
        const { selected: targets, skipped } = selectSites(ctx.registry, { sites, tags });
        const results = await runFleet(
          targets,
          (site) => fleetHealthForSite(ctx.registry.client(site.id), site),
          ctx.env.FLEET_CONCURRENCY,
        );
        const summary = {
          sites: results.length,
          ok: results.filter((r) => r.ok && r.data?.ok).length,
          failed: results.filter((r) => !r.ok || !r.data?.ok).length,
          skipped: skipped.length,
        };
        return jsonResult({ summary, results, skipped });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'fleet_updates_report',
    {
      title: 'Fleet updates report',
      description:
        'Reports available core/plugin/theme/translation updates across the fleet, via nb-mcp-bridge on each site. Filter with sites/tags; defaults to every available site. Returns a summary of totals plus per-site details. Per-site errors (e.g. bridge not installed) never fail the whole call. Read-only.',
      inputSchema: {
        ...siteFilterSchema,
        refresh: z.boolean().optional().describe('Force a fresh update check on every site instead of using cached data'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sites, tags, refresh }) => {
      try {
        const { selected: targets, skipped } = selectSites(ctx.registry, { sites, tags });
        const results = await runFleet(
          targets,
          (site) => fetchBridgeUpdates(ctx.registry.client(site.id), refresh),
          ctx.env.FLEET_CONCURRENCY,
        );
        const summary = results.reduce(
          (acc, r) => {
            if (!r.ok || !r.data) {
              acc.failed += 1;
              return acc;
            }
            acc.pendingPlugins += r.data.plugins?.length ?? 0;
            acc.pendingThemes += r.data.themes?.length ?? 0;
            acc.pendingCore += (r.data.core ?? []).filter((c) => c.response === 'upgrade').length;
            return acc;
          },
          { failed: 0, pendingPlugins: 0, pendingThemes: 0, pendingCore: 0 },
        );
        return jsonResult({
          summary: { sites: results.length, ...summary, skipped: skipped.length },
          results,
          skipped,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'fleet_find_plugin',
    {
      title: 'Find plugin across fleet',
      description:
        'Searches every site in the fleet for a plugin matching `query`, case-insensitively against the plugin file (e.g. "akismet/akismet"), its slug (the directory part), or its display name. Use this to find where a plugin is installed, and its version/status per site, before acting on it (e.g. with fleet_update_plugin). Filter with sites/tags; defaults to every available site. Read-only.',
      inputSchema: {
        query: z.string().min(1).describe('Case-insensitive match against plugin file, slug, or name'),
        ...siteFilterSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, sites, tags }) => {
      try {
        const { selected: targets, skipped } = selectSites(ctx.registry, { sites, tags });
        const q = query.toLowerCase();
        const results = await runFleet(
          targets,
          async (site) => {
            const plugins = await fetchPlugins(ctx.registry.client(site.id));
            return plugins.filter((p) => {
              const slug = p.plugin.split('/')[0] ?? '';
              return (
                p.plugin.toLowerCase().includes(q) ||
                slug.toLowerCase().includes(q) ||
                (p.name ?? '').toLowerCase().includes(q)
              );
            });
          },
          ctx.env.FLEET_CONCURRENCY,
        );
        const summary = {
          sitesChecked: results.length,
          sitesWithMatch: results.filter((r) => r.ok && (r.data?.length ?? 0) > 0).length,
          failed: results.filter((r) => !r.ok).length,
          skipped: skipped.length,
        };
        return jsonResult({
          summary,
          results: results.map((r) => ({ site: r.site, ok: r.ok, error: r.error, matches: r.data ?? [] })),
          skipped,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'fleet_user_audit',
    {
      title: 'Fleet user audit',
      description:
        'Lists WP users matching a role (default "administrator") across the fleet, optionally filtered to an exact email address (case-insensitive). Use this to audit who has admin access, or to find every account for one email, across every site. Filter with sites/tags; defaults to every available site. Read-only.',
      inputSchema: {
        role: z.string().optional().describe('Role slug to match (default "administrator")'),
        email: z.string().optional().describe('Only users with this exact email address (case-insensitive)'),
        ...siteFilterSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ role, email, sites, tags }) => {
      try {
        const { selected: targets, skipped } = selectSites(ctx.registry, { sites, tags });
        const results = await runFleet(
          targets,
          (site) => fetchUsersForAudit(ctx.registry.client(site.id), role ?? 'administrator', email),
          ctx.env.FLEET_CONCURRENCY,
        );
        const summary = {
          sitesChecked: results.length,
          totalUsers: results.reduce((sum, r) => sum + (r.data?.length ?? 0), 0),
          failed: results.filter((r) => !r.ok).length,
          skipped: skipped.length,
        };
        return jsonResult({
          summary,
          results: results.map((r) => ({ site: r.site, ok: r.ok, error: r.error, users: r.data ?? [] })),
          skipped,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  if (!ctx.readOnlyGlobal) {
    server.registerTool(
      'fleet_update_plugin',
      {
        title: 'Fleet-wide plugin update',
        description:
          'Updates one plugin, by id (e.g. "akismet/akismet"), on every site in the fleet that currently has an update available for it, via nb-mcp-bridge. Sites configured readOnly are never written to — they are skipped and reported. Filter with sites/tags; defaults to every available site. This is a write tool: it requires confirm: true to actually run; without confirm it returns a dry-run preview per site listing the current ("from") and available ("to") version, and changes nothing. Can take a while — uses WP_UPDATE_TIMEOUT_MS.',
        inputSchema: {
          plugin: z.string().describe('Plugin identifier, e.g. "akismet/akismet" (with or without ".php")'),
          confirm: z.boolean().optional().describe('Must be true to actually update; otherwise a dry-run preview is returned'),
          ...siteFilterSchema,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ plugin, confirm, sites, tags }) => {
        try {
          const { route, file } = validatePluginId(plugin);
          const confirmed = confirm === true;
          const { selected: targets, skipped } = selectSites(ctx.registry, { sites, tags });

          const rawResults = await runFleet(
            targets,
            async (site) => {
              const client = ctx.registry.client(site.id);
              const updates = await fetchBridgeUpdates(client);
              const info = (updates.plugins ?? []).find((p) => stripPhp(p.plugin) === route);

              if (!info) {
                return { status: 'no_update_available' as const };
              }
              if (!confirmed) {
                return { status: 'dry_run' as const, from: info.current_version, to: info.new_version };
              }
              try {
                requireWritable(site);
              } catch (err) {
                return {
                  status: 'skipped_read_only' as const,
                  from: info.current_version,
                  to: info.new_version,
                  reason: err instanceof Error ? err.message : String(err),
                };
              }
              try {
                const data = await client.bridge<{
                  results?: Array<{ plugin: string; success: boolean; error?: string }>;
                }>('/updates/plugins', {
                  method: 'POST',
                  body: { plugins: [file] },
                  timeoutMs: ctx.env.WP_UPDATE_TIMEOUT_MS,
                });
                const bridgeResult = data.results?.[0];
                if (!bridgeResult) {
                  const message = 'bridge returned no result';
                  ctx.audit.log({
                    tool: 'fleet_update_plugin',
                    site: site.id,
                    args: { plugin, confirm: true },
                    ok: false,
                    error: message,
                  });
                  return {
                    status: 'failed' as const,
                    from: info.current_version,
                    to: info.new_version,
                    error: message,
                  };
                }
                if (bridgeResult.success === false) {
                  const message = bridgeResult.error ?? `bridge reported failure updating ${file}`;
                  ctx.audit.log({
                    tool: 'fleet_update_plugin',
                    site: site.id,
                    args: { plugin, confirm: true },
                    ok: false,
                    error: message,
                  });
                  return {
                    status: 'failed' as const,
                    from: info.current_version,
                    to: info.new_version,
                    error: message,
                  };
                }
                ctx.audit.log({ tool: 'fleet_update_plugin', site: site.id, args: { plugin, confirm: true }, ok: true });
                return { status: 'updated' as const, from: info.current_version, to: info.new_version, data };
              } catch (err) {
                ctx.audit.log({
                  tool: 'fleet_update_plugin',
                  site: site.id,
                  args: { plugin, confirm: true },
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                });
                throw err;
              }
            },
            ctx.env.FLEET_CONCURRENCY,
          );

          // A per-site "failed" outcome is returned as data, not a thrown error (so the
          // preview/skip statuses stay alongside it) — surface it as ok:false here too, so
          // the fleet-level `results` array doesn't misreport a failed update as ok:true.
          const results = rawResults.map((r) =>
            r.ok && r.data?.status === 'failed' ? { ...r, ok: false, error: r.data.error ?? 'update failed' } : r,
          );

          const summary = results.reduce(
            (acc, r) => {
              if (!r.ok) {
                acc.failed += 1;
                return acc;
              }
              switch (r.data?.status) {
                case 'updated':
                  acc.updated += 1;
                  break;
                case 'dry_run':
                  acc.wouldUpdate += 1;
                  break;
                case 'skipped_read_only':
                  acc.skippedReadOnly += 1;
                  break;
                case 'no_update_available':
                  acc.noUpdateAvailable += 1;
                  break;
                case 'failed':
                  acc.failed += 1;
                  break;
              }
              return acc;
            },
            { updated: 0, wouldUpdate: 0, skippedReadOnly: 0, noUpdateAvailable: 0, failed: 0 },
          );

          return jsonResult({
            dryRun: !confirmed,
            plugin: route,
            summary: { ...summary, skipped: skipped.length },
            results,
            skipped,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }
}
