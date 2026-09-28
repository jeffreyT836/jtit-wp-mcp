import { z } from 'zod';
import type { WpClient } from './client.js';

/** Shared WordPress user logic for the MCP tools and the dashboard. */

export interface WpUser {
  id: number;
  username?: string;
  slug?: string;
  name?: string;
  email?: string;
  roles?: string[];
  registered_date?: string;
}

export interface UserSummary {
  id: number;
  username: string;
  name?: string;
  email?: string;
  roles: string[];
  registered_date?: string;
}

export interface RoleSummary {
  slug: string;
  name: string;
  user_count?: number;
}

/** WP-safe username: letters, numbers, `_ . @ -` (matches `sanitize_user()`'s allowed set). */
export const usernameSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9_.@-]+$/, 'username must contain only letters, numbers, and _ . @ -');

export const roleSlugSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/, 'invalid role slug');

/** The default roles, used when the site has no bridge to list its (custom) roles. */
export const DEFAULT_ROLES: RoleSummary[] = [
  { slug: 'subscriber', name: 'Abonnee' },
  { slug: 'contributor', name: 'Schrijver' },
  { slug: 'author', name: 'Auteur' },
  { slug: 'editor', name: 'Redacteur' },
  { slug: 'administrator', name: 'Beheerder' },
];

export function mapUser(user: WpUser): UserSummary {
  return {
    id: user.id,
    username: user.username ?? user.slug ?? '',
    name: user.name,
    email: user.email,
    roles: user.roles ?? [],
    registered_date: user.registered_date,
  };
}

export async function listUsers(client: WpClient): Promise<UserSummary[]> {
  const users = await client.getAll<WpUser>('/wp/v2/users', { context: 'edit' });
  return users.map(mapUser);
}

/** The account the server itself authenticates as. */
export async function currentUser(client: WpClient): Promise<UserSummary> {
  return mapUser(await client.request<WpUser>('/wp/v2/users/me', { query: { context: 'edit' } }));
}

/** The site's roles via the bridge; falls back to the WordPress defaults without it. */
export async function listRoles(client: WpClient, bridge: boolean): Promise<RoleSummary[]> {
  if (!bridge) return DEFAULT_ROLES;
  const result = await client.bridge<{ roles?: RoleSummary[] }>('/roles');
  return result?.roles?.length ? result.roles : DEFAULT_ROLES;
}

export interface NewUser {
  username: string;
  email: string;
  role: string;
  password: string;
  first_name?: string;
  last_name?: string;
}

/** Creates a user. The password is sent to WordPress only and never returned. */
export async function createUser(client: WpClient, input: NewUser): Promise<UserSummary> {
  const body: Record<string, unknown> = {
    username: input.username,
    email: input.email,
    roles: [input.role],
    password: input.password,
  };
  if (input.first_name) body.first_name = input.first_name;
  if (input.last_name) body.last_name = input.last_name;
  return mapUser(await client.request<WpUser>('/wp/v2/users', { method: 'POST', body }));
}

/** Fetches the target user + the bot's own identity, and refuses deleting its own account. */
export async function loadAndGuardDeletion(client: WpClient, targetId: number): Promise<{ target: WpUser; me: WpUser }> {
  const [target, me] = await Promise.all([
    client.request<WpUser>(`/wp/v2/users/${targetId}`, { query: { context: 'edit' } }),
    client.request<WpUser>('/wp/v2/users/me', { query: { context: 'edit' } }),
  ]);
  if (me.id === targetId) {
    throw new Error(
      'refusing to delete the account the MCP server itself authenticates as (this would lock the server out of the site)',
    );
  }
  return { target, me };
}

/** Permanently deletes a user after the guards, reassigning their content. */
export async function deleteUser(client: WpClient, id: number, reassign: number): Promise<UserSummary> {
  if (reassign === id) throw new Error('reassign must be a different user id than the one being deleted');
  const { target } = await loadAndGuardDeletion(client, id);
  await client.request(`/wp/v2/users/${id}`, { method: 'DELETE', query: { force: true, reassign } });
  return mapUser(target);
}
