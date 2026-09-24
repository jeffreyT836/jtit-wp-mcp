import { z } from 'zod';
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ResolvedSite } from '../config/schema.js';
import type { WpClient } from '../wp/client.js';
import type { ToolContext } from './context.js';
import { errorResult, jsonResult, requireWritable } from './helpers.js';

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

/**
 * Mirrors {@link import('./helpers.js').registerWriteTool}'s confirm/dry-run/readOnly/audit
 * contract, but allows the preview to be async so a dry-run can fetch the site's current
 * settings and show a current -> new diff. See users.ts for the identical pattern (kept
 * local to each module to avoid a shared-file dependency across the write set).
 */
function registerAsyncWriteTool<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  ctx: ToolContext,
  config: {
    name: string;
    title: string;
    description: string;
    inputSchema: Shape;
    annotations?: Record<string, unknown>;
    buildPreview: (args: ShapeOutput<Shape>, site: ResolvedSite, client: WpClient) => Promise<unknown>;
    execute: (args: ShapeOutput<Shape>, site: ResolvedSite, client: WpClient) => Promise<unknown>;
  },
): void {
  if (ctx.readOnlyGlobal) return;

  const handler: ToolCallback<Shape> = (async (args: ShapeOutput<Shape>) => {
    const siteId = String((args as Record<string, unknown>).site ?? '');
    const confirmed = (args as Record<string, unknown>).confirm === true;
    try {
      const site = ctx.registry.get(siteId);
      const client = ctx.registry.client(siteId);
      if (!confirmed) {
        const preview = await config.buildPreview(args, site, client);
        return jsonResult({ dryRun: true, wouldDo: preview });
      }
      requireWritable(site);
      const data = await config.execute(args, site, client);
      ctx.audit.log({ tool: config.name, site: siteId, args, ok: true });
      return jsonResult(data);
    } catch (err) {
      if (confirmed) {
        ctx.audit.log({
          tool: config.name,
          site: siteId,
          args,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return errorResult(err);
    }
  }) as unknown as ToolCallback<Shape>;

  server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: { readOnlyHint: false, ...config.annotations },
    },
    handler,
  );
}

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

  registerAsyncWriteTool(server, ctx, {
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
    buildPreview: async (args, _site, client) => {
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
