import type { WpClient } from './client.js';
import { requireBridgeFeature } from './site-health.js';
import type { NewUser, RoleSummary, UserSummary } from './users.js';

/** Shared multisite logic (nb-mcp-bridge 1.2.0 `/network/...`) for MCP tools and dashboard. */

export interface NetworkSite {
  blog_id: number;
  name: string;
  url: string;
  domain: string;
  path: string;
  registered: string;
  last_updated: string;
  public: boolean;
  archived: boolean;
  deleted: boolean;
  spam: boolean;
  is_main: boolean;
}

export interface NetworkOverview {
  multisite: boolean;
  network: { name: string; domain: string; main_site_id: number } | null;
  total: number;
  sites: NetworkSite[];
}

export interface NetworkSiteDetail extends NetworkSite {
  admin_email: string;
  language: string;
  theme: { stylesheet: string; name: string; version: string };
  plugins: Array<{ plugin: string; name: string; version: string; network: boolean }>;
  counts: { posts: number; pages: number; users: number };
}

export type BlogUser = UserSummary & { super_admin?: boolean };

const blogPath = (blogId: number, rest = '') => {
  if (!Number.isInteger(blogId) || blogId < 1) throw new Error('invalid blog id');
  return `/network/sites/${blogId}${rest}`;
};

export async function listNetworkSites(client: WpClient): Promise<NetworkOverview> {
  await requireBridgeFeature(client, 'network');
  return client.bridge<NetworkOverview>('/network/sites');
}

export async function getNetworkSite(client: WpClient, blogId: number): Promise<NetworkSiteDetail> {
  return client.bridge<NetworkSiteDetail>(blogPath(blogId));
}

export async function listBlogUsers(client: WpClient, blogId: number): Promise<{ me: number; users: BlogUser[] }> {
  const data = await client.bridge<{ me: number; users: BlogUser[] }>(blogPath(blogId, '/users'));
  return { me: data.me, users: data.users ?? [] };
}

export async function listBlogRoles(client: WpClient, blogId: number): Promise<RoleSummary[]> {
  return (await client.bridge<{ roles: RoleSummary[] }>(blogPath(blogId, '/roles'))).roles ?? [];
}

/** Creates a network user and adds it to one site. The password is never returned. */
export async function createBlogUser(client: WpClient, blogId: number, input: NewUser): Promise<BlogUser> {
  return client.bridge<BlogUser>(blogPath(blogId, '/users'), {
    method: 'POST',
    body: {
      username: input.username,
      email: input.email,
      password: input.password,
      role: input.role,
      first_name: input.first_name ?? '',
      last_name: input.last_name ?? '',
    },
  });
}

/** Removes a user from one site (their network account stays) and reassigns their content. */
export async function removeBlogUser(client: WpClient, blogId: number, userId: number, reassign: number): Promise<BlogUser> {
  if (!Number.isInteger(userId) || userId < 1 || !Number.isInteger(reassign) || reassign < 1) throw new Error('invalid user id');
  if (reassign === userId) throw new Error('reassign must be a different user id than the one being removed');
  const data = await client.bridge<{ removed: boolean; user: BlogUser }>(blogPath(blogId, `/users/${userId}/remove`), {
    method: 'POST',
    body: { reassign },
  });
  return data.user;
}
