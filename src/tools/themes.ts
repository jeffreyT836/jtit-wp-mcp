import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WpClient } from '../wp/client.js';
import type { ToolContext } from './context.js';
import { errorResult, jsonResult } from './helpers.js';

const THEME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validates a theme stylesheet slug (e.g. "twentytwentyfour") used by update tools.
 * Rejects slashes, backslashes and ".." so it can never be used to traverse paths.
 */
export function validateThemeId(raw: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error(`invalid theme identifier: ${JSON.stringify(raw)}`);
  }
  if (!THEME_ID_RE.test(value)) {
    throw new Error(
      `invalid theme identifier: ${JSON.stringify(raw)} (expected a theme stylesheet slug, e.g. "twentytwentyfour")`,
    );
  }
  return value;
}

interface WpRenderedText {
  rendered?: string;
  raw?: string;
}

interface WpTheme {
  stylesheet: string;
  template?: string;
  status?: string;
  name?: WpRenderedText | string;
  version?: string;
  author?: WpRenderedText | string;
  requires_wp?: string;
  requires_php?: string;
}

export interface ThemeSummary {
  stylesheet: string;
  template?: string;
  name?: string;
  version?: string;
  status?: string;
  author?: string;
  requires_wp?: string;
  requires_php?: string;
}

function textOf(value: WpRenderedText | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : (value.rendered ?? value.raw);
}

function mapTheme(theme: WpTheme): ThemeSummary {
  return {
    stylesheet: theme.stylesheet,
    template: theme.template,
    name: textOf(theme.name),
    version: theme.version,
    status: theme.status,
    author: textOf(theme.author),
    requires_wp: theme.requires_wp,
    requires_php: theme.requires_php,
  };
}

/**
 * Fetches every installed theme on a site, mapped to {@link ThemeSummary}. `filter.search`
 * is applied client-side (case-insensitive, against `name`/`stylesheet`): the WP REST
 * `/wp/v2/themes` endpoint accepts a `search` query param but silently ignores it.
 */
export async function fetchThemes(
  client: WpClient,
  filter: { status?: string; search?: string } = {},
): Promise<ThemeSummary[]> {
  const themes = await client.getAll<WpTheme>('/wp/v2/themes', {
    context: 'edit',
    status: filter.status,
  });
  const mapped = themes.map(mapTheme);
  if (!filter.search) return mapped;
  const q = filter.search.toLowerCase();
  return mapped.filter(
    (theme) => (theme.name ?? '').toLowerCase().includes(q) || theme.stylesheet.toLowerCase().includes(q),
  );
}

/** Registers `list_themes`. See SPEC.md §4. */
export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_themes',
    {
      title: 'List themes',
      description:
        'Lists installed themes on a site: stylesheet slug, name, version, activation status, author and requirements. Use to see what is installed/active before updating a theme. Optional status ("active"|"inactive") and search filters. Read-only.',
      inputSchema: {
        site: z.string().describe('Site id (see list_sites)'),
        status: z.enum(['active', 'inactive']).optional().describe('Only themes with this activation status'),
        search: z.string().optional().describe('Filter by a search term against the theme name'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, status, search }) => {
      try {
        const client = ctx.registry.client(site);
        const themes = await fetchThemes(client, { status, search });
        return jsonResult(themes);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
