import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { errorResult, jsonResult, registerWriteTool } from './helpers.js';

/** SPEC.md §4 allowlist for `update_settings`; any other key is rejected by the schema below. */
const settingsValuesShape = {
  title: z.string().optional(),
  description: z.string().optional(),
  timezone: z.string().optional(),
  date_format: z.string().optional(),
  time_format: z.string().optional(),
  start_of_week: z.number().int().min(0).max(6).optional(),
  language: z.string().optional(),
  posts_per_page: z.number().int().optional(),
  default_comment_status: z.enum(['open', 'closed']).optional(),
};

const settingsValuesSchema = z.object(settingsValuesShape).strict();

type SettingsValues = z.infer<typeof settingsValuesSchema>;

/** Registers `get_settings`, `update_settings`. See SPEC.md §4. */
export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_settings',
    {
      title: 'Get site settings',
      description: 'Fetches the site’s general settings (title, description, timezone, formats, etc). Read-only.',
      inputSchema: { site: z.string().describe('Site id from sites.json') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site: siteId }) => {
      try {
        const client = ctx.registry.client(siteId);
        const settings = await client.request('/wp/v2/settings');
        return jsonResult(settings);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerWriteTool(server, ctx, {
    name: 'update_settings',
    title: 'Update site settings',
    description:
      'Updates a site’s general settings. Only an allowlisted set of keys is accepted: title, ' +
      'description, timezone, date_format, time_format, start_of_week, language, posts_per_page, ' +
      'default_comment_status — any other key is rejected. Requires confirm:true; without it, returns a ' +
      'dry-run preview showing current -> new values for each key and changes nothing.',
    inputSchema: {
      site: z.string().describe('Site id from sites.json'),
      values: settingsValuesSchema.describe('Allowlisted settings keys to change.'),
      confirm: z.boolean().optional().describe('Must be true to actually apply the change.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
    wouldDo: async (args, _site, client) => {
      const current = await client.request<Record<string, unknown>>('/wp/v2/settings');
      const values = args.values as SettingsValues;
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [key, to] of Object.entries(values)) {
        if (to === undefined) continue;
        changes[key] = { from: current[key], to };
      }
      return { action: 'update_settings', site: args.site, changes };
    },
    execute: async (args, _site, client) => client.request('/wp/v2/settings', { method: 'POST', body: args.values }),
  });
}
