import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getNetworkSite, listNetworkSites } from '../wp/network.js';
import { fetchSiteHealth } from '../wp/site-health.js';
import type { ToolContext } from './context.js';
import { errorResult, jsonResult } from './helpers.js';

/** Registers `get_site_health`, `list_network_sites`, `get_network_site` (nb-mcp-bridge 1.2.0). */
export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_site_health',
    {
      title: 'Get Site Health',
      description:
        'Runs WordPress Site Health on a site (like WP-admin → Tools → Site Health → Status) via nb-mcp-bridge 1.2.0+: ' +
        'every test with status critical/recommended/good, a plain-text explanation and links, plus a limited, ' +
        'non-sensitive subset of the Info tab (versions, limits, cache, cron). Takes up to ~1 minute. Read-only.',
      inputSchema: {
        site: z.string().describe('Site id (see list_sites)'),
        include_sizes: z.boolean().optional().describe('Also compute directory and database sizes (slow on large sites).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, include_sizes }) => {
      try {
        return jsonResult(await fetchSiteHealth(ctx.registry.client(site), { includeSizes: include_sizes }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_network_sites',
    {
      title: 'List multisite network sites',
      description:
        'For a WordPress multisite network: lists every site in the network (blog_id, name, url, status flags, ' +
        'is_main). On a single site returns {multisite:false}. Requires nb-mcp-bridge 1.2.0+ and a super admin. Read-only.',
      inputSchema: { site: z.string().describe('Site id (see list_sites) of the network’s main site') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site }) => {
      try {
        return jsonResult(await listNetworkSites(ctx.registry.client(site)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_network_site',
    {
      title: 'Get multisite network site',
      description:
        'Details of one site in a multisite network: name, url, admin email, language, active theme, active ' +
        'plugins (incl. network-activated) and post/page/user counts. Read-only.',
      inputSchema: {
        site: z.string().describe('Site id (see list_sites) of the network’s main site'),
        blog_id: z.number().int().positive().describe('Blog id from list_network_sites'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, blog_id }) => {
      try {
        return jsonResult(await getNetworkSite(ctx.registry.client(site), blog_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
