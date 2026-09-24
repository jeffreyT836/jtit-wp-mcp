import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResolvedSite } from '../config/schema.js';
import { WpError, sanitizeMessage } from '../wp/errors.js';
import type { WpClient } from '../wp/client.js';
import type { ToolContext } from './context.js';
import { errorResult, jsonResult } from './helpers.js';

interface WpUserMe {
  id: number;
  username?: string;
  slug?: string;
  name?: string;
  roles?: string[];
}

interface WpIndex {
  name?: string;
  description?: string;
  url?: string;
  timezone_string?: string;
  namespaces?: string[];
}

type BridgeStatus = 'ok' | 'missing' | 'error' | 'disabled';

async function bridgeStatus(client: WpClient, site: ResolvedSite): Promise<BridgeStatus> {
  if (site.bridge === false) return 'disabled';
  try {
    await client.bridge('/status');
    return 'ok';
  } catch (err) {
    if (err instanceof WpError && err.code === 'nb_mcp_bridge_missing') {
      return 'missing';
    }
    return 'error';
  }
}

async function checkSite(client: WpClient, site: ResolvedSite) {
  let ok = false;
  let user: { id: number; username: string; name?: string } | undefined;
  let roles: string[] = [];
  let error: string | undefined;

  try {
    const me = await client.request<WpUserMe>('/wp/v2/users/me', { query: { context: 'edit' } });
    ok = true;
    roles = me.roles ?? [];
    user = { id: me.id, username: me.username ?? me.slug ?? '', name: me.name };
  } catch (err) {
    ok = false;
    error =
      err instanceof WpError ? err.message : sanitizeMessage(err instanceof Error ? err.message : String(err));
  }

  const bridge = await bridgeStatus(client, site);
  const isAdmin = roles.includes('administrator');

  return { ok, user, roles, isAdmin, bridge, ...(error ? { error } : {}) };
}

async function fetchSiteInfo(client: WpClient, site: ResolvedSite) {
  const index = await client.request<WpIndex>('');
  const bridge = await bridgeStatus(client, site);
  return {
    name: index.name,
    description: index.description,
    url: index.url,
    timezone_string: index.timezone_string,
    namespaces: index.namespaces,
    bridge,
  };
}

/** Registers `list_sites`, `site_check`, `site_info`. See SPEC.md §4. */
export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_sites',
    {
      title: 'List sites',
      description:
        'Lists every site configured in sites.json (id, name, url, tags, readOnly, bridge, available). Never includes secrets.',
      inputSchema: {
        tags: z.array(z.string()).optional().describe('Only include sites carrying all of these tags.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ tags }) => {
      try {
        const sites = ctx.registry.byTags(tags);
        return jsonResult(
          sites.map((site) => ({
            id: site.id,
            name: site.name,
            url: site.url,
            tags: site.tags,
            readOnly: site.readOnly,
            bridge: site.bridge,
            available: site.available,
            unavailableReason: site.unavailableReason,
          })),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'site_check',
    {
      title: 'Check site',
      description:
        'Checks connectivity and authentication for one site: current user, roles, and nb-mcp-bridge status.',
      inputSchema: { site: z.string().describe('Site id from sites.json') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site: siteId }) => {
      try {
        const site = ctx.registry.get(siteId);
        if (!site.available) {
          return jsonResult({
            site: site.id,
            ok: false,
            error: `site is unavailable: ${site.unavailableReason}`,
          });
        }
        const client = ctx.registry.client(siteId);
        const result = await checkSite(client, site);
        return jsonResult({ site: site.id, ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'site_info',
    {
      title: 'Site info',
      description: 'Fetches the WP REST index (name, description, url, timezone, namespaces) plus bridge status.',
      inputSchema: { site: z.string().describe('Site id from sites.json') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site: siteId }) => {
      try {
        const site = ctx.registry.get(siteId);
        if (!site.available) {
          return jsonResult({
            site: site.id,
            ok: false,
            error: `site is unavailable: ${site.unavailableReason}`,
          });
        }
        const client = ctx.registry.client(siteId);
        const info = await fetchSiteInfo(client, site);
        return jsonResult({ site: site.id, ...info });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
