import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WpClient } from '../wp/client.js';
import type { ToolContext } from './context.js';
import { loadAndGuardDeletion, mapUser, usernameSchema, type WpUser } from '../wp/users.js';
import { errorResult, jsonResult, registerWriteTool } from './helpers.js';

interface WpApplicationPassword {
  uuid: string;
  name: string;
  created?: string | number;
  last_used?: string | number | null;
  last_ip?: string | null;
}

const userIdSchema = z.number().int().positive().describe('WordPress user id.');
const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a UUID');

/** Generates a cryptographically random, URL-safe password of well over 24 characters. */
function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

/** Fetches the target user + the bot's own identity, and refuses removing its own admin role. */
async function loadAndGuardRoleChange(
  client: WpClient,
  targetId: number,
  newRoles: string[],
): Promise<{ current: WpUser; me: WpUser }> {
  const [current, me] = await Promise.all([
    client.request<WpUser>(`/wp/v2/users/${targetId}`, { query: { context: 'edit' } }),
    client.request<WpUser>('/wp/v2/users/me', { query: { context: 'edit' } }),
  ]);
  const currentlyAdmin = (current.roles ?? []).includes('administrator');
  if (me.id === targetId && currentlyAdmin && !newRoles.includes('administrator')) {
    throw new Error(
      'refusing to remove the administrator role from the account the MCP server itself authenticates as (this would lock the server out of the site)',
    );
  }
  return { current, me };
}

/**
 * Registers `list_users`, `get_user`, `list_roles`, `create_user`, `update_user_roles`,
 * `delete_user`, `list_application_passwords`, `revoke_application_password`.
 * See SPEC.md §4 and §5 (`/roles` bridge route).
 */
export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_users',
    {
      title: 'List users',
      description:
        'Lists WordPress users on a site as {id, username, name, email, roles, registered_date}. ' +
        'Use to find a user before calling get_user, update_user_roles, or delete_user. Read-only.',
      inputSchema: {
        site: z.string().describe('Site id (see list_sites)'),
        roles: z.array(z.string()).optional().describe('Only include users that have any of these roles.'),
        search: z.string().optional().describe('Search term matched against username, name, and email.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site: siteId, roles, search }) => {
      try {
        const client = ctx.registry.client(siteId);
        const query: Record<string, string> = {};
        if (roles && roles.length > 0) query.roles = roles.join(',');
        if (search) query.search = search;
        const users = await client.getAll<WpUser>('/wp/v2/users', { context: 'edit', ...query });
        return jsonResult(users.map(mapUser));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_user',
    {
      title: 'Get user',
      description: 'Fetches one WordPress user by id as {id, username, name, email, roles, registered_date}.',
      inputSchema: { site: z.string().describe('Site id (see list_sites)'), id: userIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site: siteId, id }) => {
      try {
        const client = ctx.registry.client(siteId);
        const user = await client.request<WpUser>(`/wp/v2/users/${id}`, { query: { context: 'edit' } });
        return jsonResult(mapUser(user));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_roles',
    {
      title: 'List roles',
      description:
        'Lists the WordPress roles defined on a site (slug, name, user_count, and optionally capabilities), ' +
        'via the nb-mcp-bridge mu-plugin. Read-only.',
      inputSchema: {
        site: z.string().describe('Site id (see list_sites)'),
        include_caps: z.boolean().optional().describe('Include each role’s capabilities map.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site: siteId, include_caps }) => {
      try {
        const client = ctx.registry.client(siteId);
        const result = await client.bridge('/roles', {
          query: include_caps ? { include_caps: 1 } : undefined,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerWriteTool(server, ctx, {
    name: 'create_user',
    title: 'Create user',
    description:
      'Creates a new WordPress user on a site. Requires confirm:true to actually create it; without it, ' +
      'returns a dry-run preview and changes nothing. If no password is given, a random 32+ character ' +
      'password is generated; it is never returned by this tool (nor shown in the dry-run preview) — ' +
      'send the new user a password-reset email instead.',
    inputSchema: {
      site: z.string().describe('Site id (see list_sites)'),
      username: usernameSchema.describe('WP-safe login username.'),
      email: z.email().describe('User email address.'),
      role: z.string().optional().describe('WordPress role slug; defaults to "subscriber".'),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      password: z
        .string()
        .min(8)
        .optional()
        .describe('Optional explicit password. Omit to have one generated and never returned.'),
      confirm: z.boolean().optional().describe('Must be true to actually create the user.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    wouldDo: (args) => ({
      action: 'create_user',
      site: args.site,
      username: args.username,
      email: args.email,
      role: args.role ?? 'subscriber',
      first_name: args.first_name,
      last_name: args.last_name,
      password: args.password
        ? '[provided; redacted, will not be echoed back]'
        : '[will be auto-generated; not returned — send a password reset]',
    }),
    execute: async (args, _site, client) => {
      const password = args.password ?? generatePassword();
      const body: Record<string, unknown> = {
        username: args.username,
        email: args.email,
        roles: [args.role ?? 'subscriber'],
        password,
      };
      if (args.first_name) body.first_name = args.first_name;
      if (args.last_name) body.last_name = args.last_name;
      const created = await client.request<WpUser>('/wp/v2/users', {
        method: 'POST',
        body,
      });
      return {
        ...mapUser(created),
        note: args.password
          ? 'password was set as provided; it is not echoed back'
          : 'a random password was generated and is not returned; send the user a password reset link',
      };
    },
  });

  registerWriteTool(server, ctx, {
    name: 'update_user_roles',
    title: 'Update user roles',
    description:
      'Replaces a user’s roles on a site. Requires confirm:true; without it, returns a dry-run preview ' +
      'showing current -> requested roles and changes nothing. Refuses to remove the administrator role ' +
      'from the account the MCP server itself authenticates as, to avoid locking the server out.',
    inputSchema: {
      site: z.string().describe('Site id (see list_sites)'),
      id: userIdSchema,
      roles: z.array(z.string()).min(1).describe('The full new set of role slugs for this user.'),
      confirm: z.boolean().optional().describe('Must be true to actually apply the role change.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
    wouldDo: async (args, _site, client) => {
      const { current } = await loadAndGuardRoleChange(client, args.id, args.roles);
      return {
        action: 'update_user_roles',
        site: args.site,
        user: { id: args.id, username: current.username ?? current.slug },
        from: current.roles ?? [],
        to: args.roles,
      };
    },
    execute: async (args, _site, client) => {
      await loadAndGuardRoleChange(client, args.id, args.roles);
      const updated = await client.request<WpUser>(`/wp/v2/users/${args.id}`, {
        method: 'POST',
        body: { roles: args.roles },
      });
      return mapUser(updated);
    },
  });

  registerWriteTool(server, ctx, {
    name: 'delete_user',
    title: 'Delete user',
    description:
      'Permanently deletes a WordPress user, reassigning their content to another user id. Requires ' +
      'confirm:true; without it, returns a dry-run preview of the user being deleted and reassign target. ' +
      '`reassign` is required and must differ from `id`. Refuses to delete the account the MCP server ' +
      'itself authenticates as. Destructive and irreversible.',
    inputSchema: {
      site: z.string().describe('Site id (see list_sites)'),
      id: userIdSchema.describe('User id to delete.'),
      reassign: z.number().int().positive().describe('User id to reassign this user’s content to; must differ from id.'),
      confirm: z.boolean().optional().describe('Must be true to actually delete the user.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
    wouldDo: async (args, _site, client) => {
      if (args.reassign === args.id) {
        throw new Error('reassign must be a different user id than the one being deleted');
      }
      const { target } = await loadAndGuardDeletion(client, args.id);
      return {
        action: 'delete_user',
        site: args.site,
        user: { id: args.id, username: target.username ?? target.slug, name: target.name },
        reassign: args.reassign,
      };
    },
    execute: async (args, _site, client) => {
      if (args.reassign === args.id) {
        throw new Error('reassign must be a different user id than the one being deleted');
      }
      await loadAndGuardDeletion(client, args.id);
      return client.request(`/wp/v2/users/${args.id}`, {
        method: 'DELETE',
        query: { force: true, reassign: args.reassign },
      });
    },
  });

  server.registerTool(
    'list_application_passwords',
    {
      title: 'List application passwords',
      description:
        'Lists a user’s application passwords as {uuid, name, created, last_used, last_ip}. ' +
        'Never includes the password values themselves (WP never returns them after creation). Read-only.',
      inputSchema: { site: z.string().describe('Site id (see list_sites)'), id: userIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site: siteId, id }) => {
      try {
        const client = ctx.registry.client(siteId);
        const passwords = await client.request<WpApplicationPassword[]>(
          `/wp/v2/users/${id}/application-passwords`,
        );
        return jsonResult(
          (passwords ?? []).map((p) => ({
            uuid: p.uuid,
            name: p.name,
            created: p.created,
            last_used: p.last_used ?? null,
            last_ip: p.last_ip ?? null,
          })),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerWriteTool(server, ctx, {
    name: 'revoke_application_password',
    title: 'Revoke application password',
    description:
      'Revokes (deletes) one application password from a user, by uuid. Requires confirm:true; without it, ' +
      'returns a dry-run preview and changes nothing. Once revoked, anything authenticating with it stops ' +
      'working immediately — destructive and irreversible.',
    inputSchema: {
      site: z.string().describe('Site id (see list_sites)'),
      id: userIdSchema.describe('Owning user id.'),
      uuid: uuidSchema.describe('The application password’s uuid, from list_application_passwords.'),
      confirm: z.boolean().optional().describe('Must be true to actually revoke it.'),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    wouldDo: (args) => ({
      action: 'revoke_application_password',
      site: args.site,
      user_id: args.id,
      uuid: args.uuid,
    }),
    execute: async (args, _site, client) =>
      client.request(`/wp/v2/users/${args.id}/application-passwords/${args.uuid}`, { method: 'DELETE' }),
  });
}
