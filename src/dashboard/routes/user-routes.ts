import { Router, type Request, type Response } from 'express';
import type { ResolvedSite } from '../../config/schema.js';
import type { WpClient } from '../../wp/client.js';
import { createBlogUser, getNetworkSite, listBlogRoles, listBlogUsers, removeBlogUser } from '../../wp/network.js';
import { bridgeStatus } from '../../wp/site-health.js';
import {
  createUser,
  currentUser,
  deleteUser,
  listRoles,
  listUsers,
  usernameSchema,
  type NewUser,
  type RoleSummary,
  type UserSummary,
} from '../../wp/users.js';
import { requireCsrf, requireFullAuth } from '../auth/session.js';
import { renderPage, type RouteContext } from '../context.js';
import { newUserFormValues, parseNewUser, userErrorMessage, type NewUserFormValues } from '../users.js';
import { html } from '../views/html.js';
import { usersPage, type UserScopeView } from '../views/user-views.js';
import { clientFor } from './site-routes.js';

const USER_ID = /^[1-9][0-9]{0,9}$/;

/** Where users are managed: the whole site (REST) or one site of a multisite network (bridge). */
interface UserScope {
  site: ResolvedSite;
  view: UserScopeView;
  /** Audit target, e.g. `klant-a` or `klant-a/blog-3`. */
  target: string;
  load(): Promise<{ users: UserSummary[]; roles: RoleSummary[]; meId: number }>;
  create(user: NewUser): Promise<UserSummary>;
  remove(id: number, reassign: number): Promise<UserSummary>;
}

function restScope(site: ResolvedSite, client: WpClient): UserScope {
  return {
    site,
    target: site.id,
    view: {
      basePath: `/sites/${site.id}/users`, title: html`Gebruikers: ${site.name}`, eyebrow: site.id,
      backHref: `/sites/${site.id}`, backLabel: 'Terug naar de site', network: false, readOnly: site.readOnly,
    },
    async load() {
      const [users, roles, me] = await Promise.all([
        listUsers(client),
        listRoles(client, site.bridge).catch(() => listRoles(client, false)),
        currentUser(client),
      ]);
      return { users, roles, meId: me.id };
    },
    create: (user) => createUser(client, user),
    remove: (id, reassign) => deleteUser(client, id, reassign),
  };
}

function networkScope(site: ResolvedSite, client: WpClient, blogId: number, opts: { main: boolean; name?: string }): UserScope {
  const basePath = opts.main ? `/sites/${site.id}/users` : `/sites/${site.id}/network/${blogId}/users`;
  return {
    site,
    target: opts.main ? site.id : `${site.id}/blog-${blogId}`,
    view: {
      basePath,
      title: html`Gebruikers: ${opts.name ?? site.name}`,
      eyebrow: opts.main ? site.id : `${site.id} · subsite ${blogId}`,
      backHref: opts.main ? `/sites/${site.id}` : `/sites/${site.id}/network/${blogId}`,
      backLabel: opts.main ? 'Terug naar de site' : 'Terug naar de subsite',
      network: true,
      readOnly: site.readOnly,
    },
    async load() {
      const [{ users, me }, roles] = await Promise.all([listBlogUsers(client, blogId), listBlogRoles(client, blogId)]);
      return { users, roles, meId: me };
    },
    create: (user) => createBlogUser(client, blogId, user),
    remove: (id, reassign) => removeBlogUser(client, blogId, id, reassign),
  };
}

/** Per-site WordPress user management: list (live), create, delete / remove from site. */
export function userRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, store } = ctx;

  router.use(['/sites/:id/users', '/sites/:id/network/:blogId/users'], requireFullAuth);

  const loadSite = (req: Request): ResolvedSite | undefined => store.load().find((s) => s.id === req.params.id);

  /**
   * Resolves the scope for a request. A multisite main site is managed through the bridge,
   * because WordPress' REST API cannot delete users on a network.
   */
  async function resolveScope(req: Request): Promise<UserScope | { site: ResolvedSite; error: string } | undefined> {
    const site = loadSite(req);
    if (!site) return undefined;
    if (!site.available) return { site, error: site.unavailableReason ?? 'site is niet beschikbaar' };
    const client = clientFor(ctx, site);
    if (req.params.blogId !== undefined) {
      const blogId = String(req.params.blogId);
      if (!USER_ID.test(blogId)) return { site, error: 'Ongeldige subsite.' };
      try {
        const detail = await getNetworkSite(client, Number(blogId));
        return networkScope(site, client, Number(blogId), { main: false, name: detail.name });
      } catch (err) {
        return { site, error: userErrorMessage(err) };
      }
    }
    if (site.bridge) {
      const status = await bridgeStatus(client).catch(() => undefined);
      if (status?.multisite && status.main_site_id && (status.features ?? []).includes('network')) {
        return networkScope(site, client, status.main_site_id, { main: true });
      }
    }
    return restScope(site, client);
  }

  async function render(
    res: Response,
    scope: UserScope | { site: ResolvedSite; error: string },
    opts: { flash?: { kind: 'ok' | 'error'; message: string }; formError?: string; values?: NewUserFormValues; status?: number } = {},
  ): Promise<void> {
    const csrf = res.locals.auth!.session.csrf_token;
    let page;
    if ('error' in scope) {
      const site = scope.site;
      page = usersPage({
        csrf,
        loadError: scope.error,
        scope: {
          basePath: `/sites/${site.id}/users`, title: html`Gebruikers: ${site.name}`, eyebrow: site.id,
          backHref: `/sites/${site.id}`, backLabel: 'Terug naar de site', network: false, readOnly: site.readOnly,
        },
      });
    } else {
      try {
        const { users, roles, meId } = await scope.load();
        page = usersPage({ csrf, scope: scope.view, users, roles, meId, formError: opts.formError, values: opts.values });
      } catch (err) {
        page = usersPage({ csrf, scope: scope.view, loadError: userErrorMessage(err) });
      }
    }
    renderPage(res, { title: `Gebruikers · ${scope.site.name}`, flash: opts.flash, body: page }, opts.status ?? 200);
  }

  const listHandler = async (req: Request, res: Response) => {
    const scope = await resolveScope(req);
    if (!scope) return res.redirect(303, '/');
    // Only echo valid usernames, so a crafted link cannot put arbitrary text in the flash.
    const named = (v: unknown) => (usernameSchema.safeParse(v).success ? (v as string) : undefined);
    const created = named(req.query.created);
    const deleted = named(req.query.deleted);
    const flash = created
      ? { kind: 'ok' as const, message: `Gebruiker "${created}" is aangemaakt.` }
      : deleted
        ? { kind: 'ok' as const, message: `Gebruiker "${deleted}" is verwijderd.` }
        : undefined;
    await render(res, scope, { flash });
  };

  const createHandler = async (req: Request, res: Response) => {
    const scope = await resolveScope(req);
    if (!scope) return res.redirect(303, '/');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const values = newUserFormValues(body);
    if (scope.site.readOnly) return render(res, scope, { formError: 'Deze site staat op "alleen lezen".', status: 403 });
    if ('error' in scope) return render(res, scope, { status: 422 });

    const parsed = parseNewUser(body);
    if (!parsed.ok) return render(res, scope, { formError: parsed.error, values, status: 422 });

    const actor = res.locals.auth!.user.email;
    try {
      const created = await scope.create(parsed.user);
      // Never audit the password; the email is kept out of the log as well.
      db.audit(actor, 'wp_user_created', scope.target, { id: created.id, username: created.username, role: parsed.user.role });
      res.redirect(303, `${scope.view.basePath}?created=${encodeURIComponent(created.username)}`);
    } catch (err) {
      const message = userErrorMessage(err);
      db.audit(actor, 'wp_user_create_failed', scope.target, { username: parsed.user.username, role: parsed.user.role, error: message });
      await render(res, scope, { formError: message, values, status: 422 });
    }
  };

  const deleteHandler = async (req: Request, res: Response) => {
    const scope = await resolveScope(req);
    if (!scope) return res.redirect(303, '/');
    if (scope.site.readOnly) return render(res, scope, { flash: { kind: 'error', message: 'Deze site staat op "alleen lezen".' }, status: 403 });
    if ('error' in scope) return render(res, scope, { status: 422 });
    const userId = String(req.params.userId);
    const reassign = typeof req.body?.reassign === 'string' ? req.body.reassign : '';
    if (!USER_ID.test(userId) || !USER_ID.test(reassign)) {
      return render(res, scope, { flash: { kind: 'error', message: 'Ongeldige gebruiker.' }, status: 422 });
    }
    if (req.body?.confirm !== 'on') {
      return render(res, scope, { flash: { kind: 'error', message: 'Vink de bevestiging aan om te verwijderen.' }, status: 422 });
    }

    const actor = res.locals.auth!.user.email;
    try {
      const deleted = await scope.remove(Number(userId), Number(reassign));
      db.audit(actor, scope.view.network ? 'wp_user_removed_from_site' : 'wp_user_deleted', scope.target, {
        id: deleted.id, username: deleted.username, reassign: Number(reassign),
      });
      res.redirect(303, `${scope.view.basePath}?deleted=${encodeURIComponent(deleted.username)}`);
    } catch (err) {
      const message = userErrorMessage(err);
      db.audit(actor, 'wp_user_delete_failed', scope.target, { id: Number(userId), error: message });
      await render(res, scope, { flash: { kind: 'error', message: `Verwijderen mislukt: ${message}` }, status: 422 });
    }
  };

  for (const base of ['/sites/:id/users', '/sites/:id/network/:blogId/users']) {
    router.get(base, listHandler);
    router.post(base, requireCsrf, createHandler);
    router.post(`${base}/:userId/delete`, requireCsrf, deleteHandler);
  }

  return router;
}
