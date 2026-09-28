import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  fetchBridgeUpdates,
  isCoreNoUpdate,
  postCoreUpdate,
  postPluginUpdates,
  postThemeUpdates,
  postTranslationUpdates,
  resolveCoreUpdate,
  resolvePluginUpdateTargets,
  resolveThemeUpdateTargets,
} from '../wp/updates.js';
import type { ToolContext } from './context.js';
import { errorResult, jsonResult, registerWriteTool, writeOutcome } from './helpers.js';

export {
  compareVersions,
  fetchBridgeUpdates,
  selectCoreUpdate,
  stripPhp,
  type BridgeUpdates,
  type BridgeUpdatesCore,
  type BridgeUpdatesPlugin,
  type BridgeUpdatesTheme,
  type CoreUpdateSelection,
} from '../wp/updates.js';

/** Summarizes per-item bridge failures for the audit log, e.g. "1/2 plugin update(s) failed: akismet/akismet: checksum mismatch". */
function summarizeFailures(label: string, items: Array<{ id: string; success: boolean; error?: string }>): string {
  const failedItems = items.filter((i) => i.success === false);
  const detail = failedItems.map((i) => (i.error ? `${i.id}: ${i.error}` : i.id)).join('; ');
  return `${failedItems.length}/${items.length} ${label} update(s) failed${detail ? `: ${detail}` : ''}`;
}

/** Registers `list_updates`, `update_plugins`, `update_themes`, `update_core`, `update_translations`. See SPEC.md §4/§5. */
export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_updates',
    {
      title: 'List updates',
      description:
        'Lists available core, plugin, theme and translation updates for a site, via the nb-mcp-bridge mu-plugin. Pass refresh:true to force WordPress to check again (slower, hits wordpress.org) instead of using its cached transients. Use this before update_plugins/update_themes/update_core to see what is available. Read-only.',
      inputSchema: {
        site: z.string().describe('Site id (see list_sites)'),
        refresh: z.boolean().optional().describe('Force a fresh update check instead of using cached data'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, refresh }) => {
      try {
        const client = ctx.registry.client(site);
        const data = await fetchBridgeUpdates(client, refresh);
        return jsonResult(data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerWriteTool(server, ctx, {
    name: 'update_plugins',
    title: 'Update plugins',
    description:
      'Updates one or more plugins to their latest available version on a site, via nb-mcp-bridge. Pass "plugins": ["dir/file", ...] (e.g. "akismet/akismet") for specific plugins, or "all": true to update every plugin that currently has an update available. This is a write tool: it requires confirm: true to actually run the update; without confirm it returns a dry-run preview listing each plugin with its current ("from") and available ("to") version, and changes nothing. Can take a while — uses WP_UPDATE_TIMEOUT_MS.',
    inputSchema: {
      site: z.string().describe('Site id (see list_sites)'),
      plugins: z
        .array(z.string())
        .optional()
        .describe('Plugin identifiers, e.g. "akismet/akismet" (with or without ".php")'),
      all: z.boolean().optional().describe('Update every plugin that currently has an update available'),
      confirm: z.boolean().optional().describe('Must be true to actually update; otherwise a dry-run preview is returned'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    wouldDo: async (args, site, client) => {
      const { preview, noUpdateAvailable } = await resolvePluginUpdateTargets(args, client);
      if (preview.length === 0 && noUpdateAvailable.length === 0) {
        return { action: 'update_plugins', site: site.id, message: 'no plugin updates available' };
      }
      return {
        action: 'update_plugins',
        site: site.id,
        ...(preview.length > 0 ? { updates: preview } : {}),
        ...(noUpdateAvailable.length > 0 ? { no_update_available: noUpdateAvailable } : {}),
      };
    },
    execute: async (args, _site, client) => {
      const { files, noUpdateAvailable } = await resolvePluginUpdateTargets(args, client);
      if (files.length === 0) {
        // Every explicitly requested plugin has no pending update (now confirmed fresh via
        // refresh:true) — a truthful, non-error outcome, not a silent no-op.
        if (noUpdateAvailable.length > 0) {
          return { status: 'up_to_date' as const, noUpdateAvailable };
        }
        return { updated: false, message: 'no plugin updates available', results: [] };
      }
      const data = await postPluginUpdates(client, files, ctx.env.WP_UPDATE_TIMEOUT_MS);
      const results = data.results ?? [];
      if (results.length === 0) return data;
      const failed = results.filter((r) => r.success === false).length;
      return writeOutcome(data, {
        failed,
        total: results.length,
        errorSummary:
          failed > 0
            ? summarizeFailures(
                'plugin',
                results.map((r) => ({ id: r.plugin, success: r.success, error: r.error })),
              )
            : undefined,
      });
    },
  });

  registerWriteTool(server, ctx, {
    name: 'update_themes',
    title: 'Update themes',
    description:
      'Updates one or more themes to their latest available version on a site, via nb-mcp-bridge. Pass "themes": ["stylesheet", ...] (e.g. "twentytwentyfour") for specific themes, or "all": true to update every theme that currently has an update available. This is a write tool: it requires confirm: true to actually run the update; without confirm it returns a dry-run preview listing each theme with its current ("from") and available ("to") version, and changes nothing. Can take a while — uses WP_UPDATE_TIMEOUT_MS.',
    inputSchema: {
      site: z.string().describe('Site id (see list_sites)'),
      themes: z.array(z.string()).optional().describe('Theme stylesheet slugs, e.g. "twentytwentyfour"'),
      all: z.boolean().optional().describe('Update every theme that currently has an update available'),
      confirm: z.boolean().optional().describe('Must be true to actually update; otherwise a dry-run preview is returned'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    wouldDo: async (args, site, client) => {
      const { preview, noUpdateAvailable } = await resolveThemeUpdateTargets(args, client);
      if (preview.length === 0 && noUpdateAvailable.length === 0) {
        return { action: 'update_themes', site: site.id, message: 'no theme updates available' };
      }
      return {
        action: 'update_themes',
        site: site.id,
        ...(preview.length > 0 ? { updates: preview } : {}),
        ...(noUpdateAvailable.length > 0 ? { no_update_available: noUpdateAvailable } : {}),
      };
    },
    execute: async (args, _site, client) => {
      const { files, noUpdateAvailable } = await resolveThemeUpdateTargets(args, client);
      if (files.length === 0) {
        // Every explicitly requested theme has no pending update (now confirmed fresh via
        // refresh:true) — a truthful, non-error outcome, not a silent no-op.
        if (noUpdateAvailable.length > 0) {
          return { status: 'up_to_date' as const, noUpdateAvailable };
        }
        return { updated: false, message: 'no theme updates available', results: [] };
      }
      const data = await postThemeUpdates(client, files, ctx.env.WP_UPDATE_TIMEOUT_MS);
      const results = data.results ?? [];
      if (results.length === 0) return data;
      const failed = results.filter((r) => r.success === false).length;
      return writeOutcome(data, {
        failed,
        total: results.length,
        errorSummary:
          failed > 0
            ? summarizeFailures(
                'theme',
                results.map((r) => ({ id: r.theme, success: r.success, error: r.error })),
              )
            : undefined,
      });
    },
  });

  registerWriteTool(server, ctx, {
    name: 'update_core',
    title: 'Update WordPress core',
    description:
      'Updates WordPress core to the latest available version on a site, via nb-mcp-bridge. By default only minor/security updates are applied; pass allow_major:true to also allow a major version bump. This is a write tool: it requires confirm: true to actually run the update; without confirm it returns a dry-run preview of the available update (if any), and changes nothing. Can take a while — uses WP_UPDATE_TIMEOUT_MS.',
    inputSchema: {
      site: z.string().describe('Site id (see list_sites)'),
      allow_major: z.boolean().optional().describe('Allow a major version update (default false: minor/security only)'),
      confirm: z.boolean().optional().describe('Must be true to actually update; otherwise a dry-run preview is returned'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    wouldDo: async (args, site, client) => {
      const allowMajor = args.allow_major ?? false;
      const { chosen, blockingMajor } = await resolveCoreUpdate(client, allowMajor);
      if (chosen) {
        return {
          action: 'update_core',
          site: site.id,
          from: chosen.current,
          to: chosen.version,
          allow_major: allowMajor,
        };
      }
      if (blockingMajor) {
        return {
          action: 'update_core',
          site: site.id,
          message: `update to ${blockingMajor.version} is a major version change from ${blockingMajor.current}; would be refused — pass allow_major:true to allow it`,
          blocked_major: { from: blockingMajor.current, to: blockingMajor.version },
        };
      }
      return { action: 'update_core', site: site.id, message: 'core is already up to date' };
    },
    execute: async (args, _site, client) => {
      // Always ask the bridge, even if the last (now-refreshed) check showed nothing to do —
      // the bridge itself has the freshest view and is the source of truth for "up to date".
      const data = await postCoreUpdate(client, args.allow_major ?? false, ctx.env.WP_UPDATE_TIMEOUT_MS);
      if (isCoreNoUpdate(data)) {
        return { status: 'up_to_date' as const, from: data.from, to: data.to };
      }
      if (data && data.success === false) {
        return writeOutcome(data, { failed: 1, total: 1, errorSummary: data.error ?? 'core update failed' });
      }
      return data;
    },
  });

  registerWriteTool(server, ctx, {
    name: 'update_translations',
    title: 'Update translations',
    description:
      'Updates translation files for core, plugins and themes on a site, via nb-mcp-bridge. This is a write tool: it requires confirm: true to actually run; without confirm it returns a dry-run preview and changes nothing. Uses WP_UPDATE_TIMEOUT_MS.',
    inputSchema: {
      site: z.string().describe('Site id (see list_sites)'),
      confirm: z.boolean().optional().describe('Must be true to actually update; otherwise a dry-run preview is returned'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    wouldDo: (args) => ({ action: 'update_translations', site: args.site }),
    execute: async (_args, _site, client) => {
      const data = await postTranslationUpdates(client, ctx.env.WP_UPDATE_TIMEOUT_MS);
      const failed = data.failed ?? (data.success === false ? 1 : 0);
      const nothingPending = data.no_update === true || (data.success !== false && (data.count ?? 0) === 0);
      if (nothingPending && failed === 0) {
        return { status: 'up_to_date' as const, count: 0 };
      }
      if (data.success === false || failed > 0) {
        const succeeded = data.count ?? 0;
        const errorSummary = data.errors?.length ? data.errors.join('; ') : (data.error ?? 'translations update failed');
        return writeOutcome(data, { failed: Math.max(failed, 1), total: succeeded + Math.max(failed, 1), errorSummary });
      }
      return data;
    },
  });
}
