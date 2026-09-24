import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WpClient } from '../wp/client.js';
import type { ToolContext } from './context.js';
import { errorResult, jsonResult, registerWriteTool, writeOutcome } from './helpers.js';
import { validatePluginId } from './plugins.js';
import { validateThemeId } from './themes.js';

export interface BridgeUpdatesPlugin {
  plugin: string;
  name?: string;
  current_version?: string;
  new_version?: string;
  package_available?: boolean;
}

export interface BridgeUpdatesTheme {
  stylesheet: string;
  name?: string;
  current_version?: string;
  new_version?: string;
  package_available?: boolean;
}

export interface BridgeUpdatesCore {
  current?: string;
  version?: string;
  response?: string;
  locale?: string;
}

export interface BridgeUpdates {
  checked_at?: string;
  core?: BridgeUpdatesCore[];
  plugins?: BridgeUpdatesPlugin[];
  themes?: BridgeUpdatesTheme[];
  translations?: { count: number };
}

/** Strips a trailing ".php" from a plugin file, e.g. "akismet/akismet.php" -> "akismet/akismet". */
export function stripPhp(file: string): string {
  return file.endsWith('.php') ? file.slice(0, -4) : file;
}

/** `GET /nb-mcp/v1/updates` — the nb-mcp-bridge update-check endpoint. See SPEC.md §5. */
export async function fetchBridgeUpdates(client: WpClient, refresh?: boolean): Promise<BridgeUpdates> {
  return client.bridge<BridgeUpdates>('/updates', { query: refresh ? { refresh: 1 } : undefined });
}

interface PluginUpdateTarget {
  /** Files to actually POST to `/updates/plugins` — only those with a pending update. */
  files: string[];
  preview: Array<{ plugin: string; from?: string; to?: string }>;
  /** Explicitly requested plugins that have no pending update, per SPEC.md — never listed as would-update. */
  noUpdateAvailable: Array<{ plugin: string; status: 'no_update_available' }>;
}

async function resolvePluginUpdateTargets(
  args: { plugins?: string[]; all?: boolean },
  client: WpClient,
): Promise<PluginUpdateTarget> {
  if (!args.all && (!args.plugins || args.plugins.length === 0)) {
    throw new Error('update_plugins requires either a non-empty "plugins" array or "all: true"');
  }
  const updates = await fetchBridgeUpdates(client);
  const byRoute = new Map((updates.plugins ?? []).map((p) => [stripPhp(p.plugin), p]));

  if (args.all) {
    const entries = updates.plugins ?? [];
    return {
      files: entries.map((p) => p.plugin),
      preview: entries.map((p) => ({ plugin: stripPhp(p.plugin), from: p.current_version, to: p.new_version })),
      noUpdateAvailable: [],
    };
  }

  const validated = (args.plugins ?? []).map(validatePluginId);
  const files: string[] = [];
  const preview: Array<{ plugin: string; from?: string; to?: string }> = [];
  const noUpdateAvailable: Array<{ plugin: string; status: 'no_update_available' }> = [];
  for (const v of validated) {
    const info = byRoute.get(v.route);
    if (info) {
      files.push(v.file);
      preview.push({ plugin: v.route, from: info.current_version, to: info.new_version });
    } else {
      noUpdateAvailable.push({ plugin: v.route, status: 'no_update_available' });
    }
  }
  return { files, preview, noUpdateAvailable };
}

interface ThemeUpdateTarget {
  /** Stylesheets to actually POST to `/updates/themes` — only those with a pending update. */
  files: string[];
  preview: Array<{ theme: string; from?: string; to?: string }>;
  /** Explicitly requested themes that have no pending update — never listed as would-update. */
  noUpdateAvailable: Array<{ theme: string; status: 'no_update_available' }>;
}

async function resolveThemeUpdateTargets(
  args: { themes?: string[]; all?: boolean },
  client: WpClient,
): Promise<ThemeUpdateTarget> {
  if (!args.all && (!args.themes || args.themes.length === 0)) {
    throw new Error('update_themes requires either a non-empty "themes" array or "all: true"');
  }
  const updates = await fetchBridgeUpdates(client);
  const byStylesheet = new Map((updates.themes ?? []).map((t) => [t.stylesheet, t]));

  if (args.all) {
    const entries = updates.themes ?? [];
    return {
      files: entries.map((t) => t.stylesheet),
      preview: entries.map((t) => ({ theme: t.stylesheet, from: t.current_version, to: t.new_version })),
      noUpdateAvailable: [],
    };
  }

  const validated = (args.themes ?? []).map(validateThemeId);
  const files: string[] = [];
  const preview: Array<{ theme: string; from?: string; to?: string }> = [];
  const noUpdateAvailable: Array<{ theme: string; status: 'no_update_available' }> = [];
  for (const stylesheet of validated) {
    const info = byStylesheet.get(stylesheet);
    if (info) {
      files.push(stylesheet);
      preview.push({ theme: stylesheet, from: info.current_version, to: info.new_version });
    } else {
      noUpdateAvailable.push({ theme: stylesheet, status: 'no_update_available' });
    }
  }
  return { files, preview, noUpdateAvailable };
}

/** Checks for a pending core upgrade via a *fresh* (non-cached) bridge update check. */
async function resolveCoreUpdate(client: WpClient): Promise<BridgeUpdatesCore | undefined> {
  const updates = await fetchBridgeUpdates(client, true);
  return (updates.core ?? []).find((c) => c.response === 'upgrade');
}

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
        site: z.string().describe('Site id from sites.json'),
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
      site: z.string().describe('Site id from sites.json'),
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
      const { files } = await resolvePluginUpdateTargets(args, client);
      if (files.length === 0) {
        return { updated: false, message: 'no plugin updates available', results: [] };
      }
      const data = await client.bridge<{ results?: Array<{ plugin: string; success: boolean; error?: string }> }>(
        '/updates/plugins',
        { method: 'POST', body: { plugins: files }, timeoutMs: ctx.env.WP_UPDATE_TIMEOUT_MS },
      );
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
      site: z.string().describe('Site id from sites.json'),
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
      const { files } = await resolveThemeUpdateTargets(args, client);
      if (files.length === 0) {
        return { updated: false, message: 'no theme updates available', results: [] };
      }
      const data = await client.bridge<{ results?: Array<{ theme: string; success: boolean; error?: string }> }>(
        '/updates/themes',
        { method: 'POST', body: { themes: files }, timeoutMs: ctx.env.WP_UPDATE_TIMEOUT_MS },
      );
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
      site: z.string().describe('Site id from sites.json'),
      allow_major: z.boolean().optional().describe('Allow a major version update (default false: minor/security only)'),
      confirm: z.boolean().optional().describe('Must be true to actually update; otherwise a dry-run preview is returned'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    wouldDo: async (args, site, client) => {
      const core = await resolveCoreUpdate(client);
      return core
        ? {
            action: 'update_core',
            site: site.id,
            from: core.current,
            to: core.version,
            allow_major: args.allow_major ?? false,
          }
        : { action: 'update_core', site: site.id, message: 'core is already up to date' };
    },
    execute: async (args, _site, client) => {
      // Always ask the bridge, even if the last (now-refreshed) check showed nothing to do —
      // the bridge itself has the freshest view and is the source of truth for "up to date".
      const data = await client.bridge<{ success?: boolean; from?: string; to?: string; error?: string }>(
        '/updates/core',
        { method: 'POST', body: { allow_major: args.allow_major ?? false }, timeoutMs: ctx.env.WP_UPDATE_TIMEOUT_MS },
      );
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
      site: z.string().describe('Site id from sites.json'),
      confirm: z.boolean().optional().describe('Must be true to actually update; otherwise a dry-run preview is returned'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    wouldDo: (args) => ({ action: 'update_translations', site: args.site }),
    execute: async (_args, _site, client) => {
      const data = await client.bridge<{ success?: boolean; count?: number; error?: string }>('/updates/translations', {
        method: 'POST',
        timeoutMs: ctx.env.WP_UPDATE_TIMEOUT_MS,
      });
      if (data && data.success === false) {
        return writeOutcome(data, { failed: 1, total: 1, errorSummary: data.error ?? 'translations update failed' });
      }
      return data;
    },
  });
}
