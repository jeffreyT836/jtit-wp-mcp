import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { errorResult, jsonResult, registerWriteTool } from './helpers.js';

interface WpRendered {
  rendered?: string;
}

interface WpPost {
  id: number;
  title?: WpRendered;
  status?: string;
  date?: string;
  modified?: string;
  link?: string;
  author?: number;
}

interface WpComment {
  id: number;
  post?: number;
  author_name?: string;
  date?: string;
  status?: string;
  content?: WpRendered;
}

const perPageSchema = z.number().int().min(1).max(100).optional().describe('Results per page (1-100, default 20).');

function mapPost(post: WpPost) {
  return {
    id: post.id,
    title: post.title?.rendered ?? '',
    status: post.status,
    date: post.date,
    modified: post.modified,
    link: post.link,
    author: post.author,
  };
}

/** Strips HTML tags and truncates to at most `maxLength` characters. */
function excerpt(html: string | undefined, maxLength: number): string {
  const text = (html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * Maps the tool's user-friendly `status` values to the ones the WP comment REST query
 * actually understands: `approved` -> `approve`, `any` -> `all` (WP rejects/ignores the
 * former spellings). Other values (`hold`, `spam`, `trash`) pass through unchanged.
 */
function mapCommentStatusForQuery(status: string): string {
  if (status === 'approved') return 'approve';
  if (status === 'any') return 'all';
  return status;
}

function mapComment(comment: WpComment) {
  return {
    id: comment.id,
    post: comment.post,
    author_name: comment.author_name,
    date: comment.date,
    status: comment.status,
    content: excerpt(comment.content?.rendered, 300),
  };
}

/**
 * Registers `list_posts`, `list_comments`, `moderate_comment`. See SPEC.md §4.
 */
export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_posts',
    {
      title: 'List posts or pages',
      description:
        'Lists posts or pages on a site as {id, title, status, date, modified, link, author}. Use `type` to ' +
        'pick posts or pages, `status` to filter (default "any", which includes drafts/pending/etc via ' +
        'context=edit), and `search` for a text query. Read-only.',
      inputSchema: {
        site: z.string().describe('Site id (see list_sites)'),
        type: z.enum(['post', 'page']).optional().describe('Content type to list; defaults to "post".'),
        status: z
          .enum(['publish', 'draft', 'pending', 'private', 'future', 'any'])
          .optional()
          .describe('Status filter; defaults to "any".'),
        search: z.string().optional().describe('Search term.'),
        per_page: perPageSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site: siteId, type, status, search, per_page }) => {
      try {
        const client = ctx.registry.client(siteId);
        const resolvedType = type ?? 'post';
        const resolvedStatus = status ?? 'any';
        const endpoint = resolvedType === 'page' ? '/wp/v2/pages' : '/wp/v2/posts';
        const query: Record<string, string | number> = {
          status: resolvedStatus,
          per_page: per_page ?? 20,
        };
        if (resolvedStatus !== 'publish') query.context = 'edit';
        if (search) query.search = search;
        const posts = await client.request<WpPost[]>(endpoint, { query });
        return jsonResult((posts ?? []).map(mapPost));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_comments',
    {
      title: 'List comments',
      description:
        'Lists comments on a site as {id, post, author_name, date, status, content} where content is an ' +
        'HTML-stripped excerpt (max 300 chars). Defaults to status "hold" (awaiting moderation). Read-only.',
      inputSchema: {
        site: z.string().describe('Site id (see list_sites)'),
        status: z
          .enum(['hold', 'approved', 'spam', 'trash', 'any'])
          .optional()
          .describe('Status filter; defaults to "hold".'),
        search: z.string().optional().describe('Search term.'),
        per_page: perPageSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site: siteId, status, search, per_page }) => {
      try {
        const client = ctx.registry.client(siteId);
        const query: Record<string, string | number> = {
          status: mapCommentStatusForQuery(status ?? 'hold'),
          per_page: per_page ?? 20,
        };
        if (search) query.search = search;
        const comments = await client.request<WpComment[]>('/wp/v2/comments', { query });
        return jsonResult((comments ?? []).map(mapComment));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerWriteTool(server, ctx, {
    name: 'moderate_comment',
    title: 'Moderate comment',
    description:
      'Sets a comment’s moderation status (approved, hold, spam, or trash). Requires confirm:true; ' +
      'without it, returns a dry-run preview and changes nothing. Moving to "trash" issues a DELETE (without ' +
      'force, so it is recoverable from the trash); other statuses issue a POST {status}.',
    inputSchema: {
      site: z.string().describe('Site id (see list_sites)'),
      id: z.number().int().positive().describe('Comment id.'),
      status: z.enum(['approved', 'hold', 'spam', 'trash']).describe('Target moderation status.'),
      confirm: z.boolean().optional().describe('Must be true to actually apply the change.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
    wouldDo: (args) => ({
      action: 'moderate_comment',
      site: args.site,
      comment_id: args.id,
      to_status: args.status,
      method: args.status === 'trash' ? 'DELETE' : 'POST {status}',
    }),
    execute: async (args, _site, client) => {
      if (args.status === 'trash') {
        return client.request(`/wp/v2/comments/${args.id}`, { method: 'DELETE' });
      }
      return client.request(`/wp/v2/comments/${args.id}`, { method: 'POST', body: { status: args.status } });
    },
  });
}
