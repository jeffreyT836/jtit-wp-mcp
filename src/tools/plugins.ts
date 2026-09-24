import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WpClient } from '../wp/client.js';
import type { ToolContext } from './context.js';
import { errorResult, jsonResult, registerWriteTool } from './helpers.js';

/** A validated plugin identifier in both forms the WP REST API and nb-mcp-bridge want. */
export interface ValidatedPluginId {
  /** `dir/file` without the `.php` extension — the WP REST route form, e.g. "akismet/akismet". */
  route: string;
  /** `dir/file.php` — the form nb-mcp-bridge's `/updates/plugins` body wants. */
  file: string;
}

/**
 * One path segment as the WP REST plugins route allows it: `[^.\/]+` — one or more
 * characters, no dots and no slashes. Matches `(?P<plugin>[^.\/]+(?:\/[^.\/]+)?)` in WP core.
 */
const PLUGIN_SEGMENT_RE = /^[^./]+$/;

/**
 * Validates and normalizes a plugin identifier. Accepts it with or without a trailing
 * `.php`, and accepts either a single-file plugin (`hello`, no directory — e.g. Hello
 * Dolly's `hello.php`) or the usual `dir/file` shape, matching WP core's own route pattern
 * `(?P<plugin>[^.\/]+(?:\/[^.\/]+)?)`. Rejects anything else — in particular `..`, a leading
 * `/`, backslashes, more than one `/`, or a dot inside a segment (only the trailing `.php`
 * may contain one) — so a caller-supplied identifier can never be used to traverse outside
 * the plugins directory.
 */
export function validatePluginId(raw: string): ValidatedPluginId {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.startsWith('/') || value.includes('..') || value.includes('\\')) {
    throw new Error(`invalid plugin identifier: ${JSON.stringify(raw)}`);
  }
  const withoutPhp = value.endsWith('.php') ? value.slice(0, -4) : value;
  const segments = withoutPhp.split('/');
  if (segments.length > 2 || segments.some((segment) => !PLUGIN_SEGMENT_RE.test(segment))) {
    throw new Error(
      `invalid plugin identifier: ${JSON.stringify(raw)} (expected "file" or "dir/file", e.g. "hello" or "akismet/akismet")`,
    );
  }
  const route = segments.join('/');
  return { route, file: `${route}.php` };
}

/**
 * Builds the `/wp/v2/plugins/<route>` REST path for a validated route, which is either
 * `file` (single-file plugin) or `dir/file`.
 */
export function pluginRestPath(route: string): string {
  return `/wp/v2/plugins/${route.split('/').map(encodeURIComponent).join('/')}`;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,99}$/;

/** Validates a wp.org plugin slug (e.g. "akismet") used by `install_plugin`. */
export function validatePluginSlug(raw: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!SLUG_RE.test(value)) {
    throw new Error(`invalid plugin slug: ${JSON.stringify(raw)} (expected a wordpress.org slug, e.g. "akismet")`);
  }
  return value;
}

interface WpPlugin {
  plugin: string;
  name?: string;
  version?: string;
  status?: string;
  author?: string;
  requires_wp?: string;
  requires_php?: string;
  network_only?: boolean;
}

export interface PluginSummary {
  plugin: string;
  name?: string;
  version?: string;
  status?: string;
  author?: string;
  requires_wp?: string;
  requires_php?: string;
  network_only?: boolean;
}

function mapPlugin(plugin: WpPlugin): PluginSummary {
  return {
    plugin: plugin.plugin,
    name: plugin.name,
    version: plugin.version,
    status: plugin.status,
    author: plugin.author,
    requires_wp: plugin.requires_wp,
    requires_php: plugin.requires_php,
    network_only: plugin.network_only,
  };
}

/** Fetches every installed plugin on a site, mapped to {@link PluginSummary}. */
export async function fetchPlugins(
  client: WpClient,
  filter: { status?: string; search?: string } = {},
): Promise<PluginSummary[]> {
  const plugins = await client.getAll<WpPlugin>('/wp/v2/plugins', {
    status: filter.status,
    search: filter.search,
  });
  return plugins.map(mapPlugin);
}

/** Registers `list_plugins`, `activate_plugin`, `deactivate_plugin`, `install_plugin`, `delete_plugin`. See SPEC.md §4. */
export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_plugins',
    {
      title: 'List plugins',
      description:
        'Lists installed plugins on a site: plugin id (dir/file), name, version, activation status, author, and requirements. Use to see what is installed, what is active, or to find a plugin before activating/updating/deleting it. Optional status ("active"|"inactive") and search filters. Read-only.',
      inputSchema: {
        site: z.string().describe('Site id from sites.json'),
        status: z.enum(['active', 'inactive']).optional().describe('Only plugins with this activation status'),
        search: z.string().optional().describe('Filter by a search term against plugin name/description'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, status, search }) => {
      try {
        const client = ctx.registry.client(site);
        const plugins = await fetchPlugins(client, { status, search });
        return jsonResult(plugins);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerWriteTool(server, ctx, {
    name: 'activate_plugin',
    title: 'Activate plugin',
    description:
      'Activates an installed plugin on a site. Plugin id is "dir/file" (with or without ".php"), e.g. "akismet/akismet" — get it from list_plugins. This is a write tool: it requires confirm: true to actually apply the change; without confirm it returns a dry-run preview and changes nothing.',
    inputSchema: {
      site: z.string().describe('Site id from sites.json'),
      plugin: z.string().describe('Plugin identifier, e.g. "akismet/akismet"'),
      confirm: z.boolean().optional().describe('Must be true to actually activate; otherwise a dry-run preview is returned'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    wouldDo: (args) => ({ action: 'activate_plugin', site: args.site, plugin: validatePluginId(args.plugin).route }),
    execute: async (args, _site, client) => {
      const updated = await client.request<WpPlugin>(pluginRestPath(validatePluginId(args.plugin).route), {
        method: 'POST',
        body: { status: 'active' },
      });
      return mapPlugin(updated);
    },
  });

  registerWriteTool(server, ctx, {
    name: 'deactivate_plugin',
    title: 'Deactivate plugin',
    description:
      'Deactivates an installed plugin on a site. Plugin id is "dir/file" (with or without ".php"), e.g. "akismet/akismet" — get it from list_plugins. This is a write tool: it requires confirm: true to actually apply the change; without confirm it returns a dry-run preview and changes nothing.',
    inputSchema: {
      site: z.string().describe('Site id from sites.json'),
      plugin: z.string().describe('Plugin identifier, e.g. "akismet/akismet"'),
      confirm: z.boolean().optional().describe('Must be true to actually deactivate; otherwise a dry-run preview is returned'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    wouldDo: (args) => ({ action: 'deactivate_plugin', site: args.site, plugin: validatePluginId(args.plugin).route }),
    execute: async (args, _site, client) => {
      const updated = await client.request<WpPlugin>(pluginRestPath(validatePluginId(args.plugin).route), {
        method: 'POST',
        body: { status: 'inactive' },
      });
      return mapPlugin(updated);
    },
  });

  registerWriteTool(server, ctx, {
    name: 'install_plugin',
    title: 'Install plugin',
    description:
      'Installs a plugin from the WordPress.org plugin directory onto a site by its slug (e.g. "akismet"), optionally setting its activation status. This is a write tool: it requires confirm: true to actually install; without confirm it returns a dry-run preview and changes nothing.',
    inputSchema: {
      site: z.string().describe('Site id from sites.json'),
      slug: z.string().describe('WordPress.org plugin slug, e.g. "akismet" (not a premium/custom plugin)'),
      status: z.enum(['active', 'inactive']).optional().describe('Status to set after installing (default "inactive")'),
      confirm: z.boolean().optional().describe('Must be true to actually install; otherwise a dry-run preview is returned'),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    wouldDo: (args) => ({
      action: 'install_plugin',
      site: args.site,
      slug: validatePluginSlug(args.slug),
      status: args.status ?? 'inactive',
    }),
    execute: async (args, _site, client) =>
      client.request('/wp/v2/plugins', {
        method: 'POST',
        body: { slug: validatePluginSlug(args.slug), status: args.status ?? 'inactive' },
      }),
  });

  registerWriteTool(server, ctx, {
    name: 'delete_plugin',
    title: 'Delete plugin',
    description:
      'Permanently deletes an installed plugin\'s files from a site. The plugin must already be deactivated (WordPress refuses to delete an active plugin). This is destructive and a write tool: it requires confirm: true to actually delete; without confirm it returns a dry-run preview and changes nothing.',
    inputSchema: {
      site: z.string().describe('Site id from sites.json'),
      plugin: z.string().describe('Plugin identifier, e.g. "akismet/akismet"'),
      confirm: z.boolean().optional().describe('Must be true to actually delete; otherwise a dry-run preview is returned'),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    wouldDo: (args) => ({ action: 'delete_plugin', site: args.site, plugin: validatePluginId(args.plugin).route }),
    execute: async (args, _site, client) =>
      client.request(pluginRestPath(validatePluginId(args.plugin).route), { method: 'DELETE' }),
  });
}
