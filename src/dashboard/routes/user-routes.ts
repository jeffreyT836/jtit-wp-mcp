import { Router, type Request, type Response } from 'express';
import type { ResolvedSite } from '../../config/schema.js';
import { createUser, currentUser, deleteUser, listRoles, listUsers, usernameSchema } from '../../wp/users.js';
import { requireCsrf, requireFullAuth } from '../auth/session.js';
import { renderPage, type RouteContext } from '../context.js';
import { newUserFormValues, parseNewUser, userErrorMessage, type NewUserFormValues } from '../users.js';
import { usersPage } from '../views/user-views.js';
import { clientFor } from './site-routes.js';

const USER_ID = /^[1-9][0-9]{0,9}$/;

/** Per-site WordPress user management: list (live), create, delete. */
export function userRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, store } = ctx;

  router.use('/sites/:id/users', requireFullAuth);

  const loadSite = (req: Request): ResolvedSite | undefined =>
    store.load().find((s) => s.id === req.params.id);

  /** Fetches users, roles and the bot account live, then renders the page. */
  async function render(
    res: Response,
    site: ResolvedSite,
    opts: { flash?: { kind: 'ok' | 'error'; message: string }; formError?: string; values?: NewUserFormValues; status?: number } = {},
  ): Promise<void> {
    const stored = store.list().find((s) => s.id === site.id)!;
    const csrf = res.locals.auth!.session.csrf_token;
    let page;
    if (!site.available) {
      page = usersPage({ csrf, site: stored, loadError: site.unavailableReason ?? 'site is niet beschikbaar' });
    } else {
      try {
        const client = clientFor(ctx, site);
        const [users, roles, me] = await Promise.all([
          listUsers(client),
          listRoles(client, site.bridge).catch(() => listRoles(client, false)),
          currentUser(client),
        ]);
        page = usersPage({ csrf, site: stored, users, roles, me, formError: opts.formError, values: opts.values });
      } catch (err) {
        page = usersPage({ csrf, site: stored, loadError: userErrorMessage(err) });
      }
    }
    renderPage(res, { title: `Gebruikers · ${site.name}`, flash: opts.flash, body: page }, opts.status ?? 200);
  }

  router.get('/sites/:id/users', async (req, res) => {
    const site = loadSite(req);
    if (!site) return res.redirect(303, '/');
    // Only echo valid usernames, so a crafted link cannot put arbitrary text in the flash.
    const named = (v: unknown) => (usernameSchema.safeParse(v).success ? (v as string) : undefined);
    const created = named(req.query.created);
    const deleted = named(req.query.deleted);
    const flash = created
      ? { kind: 'ok' as const, message: `Gebruiker "${created}" is aangemaakt.` }
      : deleted
        ? { kind: 'ok' as const, message: `Gebruiker "${deleted}" is verwijderd.` }
        : undefined;
    await render(res, site, { flash });
  });

  router.post('/sites/:id/users', requireCsrf, async (req, res) => {
    const site = loadSite(req);
    if (!site) return res.redirect(303, '/');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const values = newUserFormValues(body);
    if (site.readOnly) return render(res, site, { formError: 'Deze site staat op "alleen lezen".', status: 403 });

    const parsed = parseNewUser(body);
    if (!parsed.ok) return render(res, site, { formError: parsed.error, values, status: 422 });

    const actor = res.locals.auth!.user.email;
    try {
      const created = await createUser(clientFor(ctx, site), parsed.user);
      // Never audit the password; the email is kept out of the log as well.
      db.audit(actor, 'wp_user_created', site.id, { id: created.id, username: created.username, role: parsed.user.role });
      res.redirect(303, `/sites/${site.id}/users?created=${encodeURIComponent(created.username)}`);
    } catch (err) {
      const message = userErrorMessage(err);
      db.audit(actor, 'wp_user_create_failed', site.id, { username: parsed.user.username, role: parsed.user.role, error: message });
      await render(res, site, { formError: message, values, status: 422 });
    }
  });

  router.post('/sites/:id/users/:userId/delete', requireCsrf, async (req, res) => {
    const site = loadSite(req);
    if (!site) return res.redirect(303, '/');
    if (site.readOnly) return render(res, site, { flash: { kind: 'error', message: 'Deze site staat op "alleen lezen".' }, status: 403 });
    const userId = String(req.params.userId);
    const reassign = typeof req.body?.reassign === 'string' ? req.body.reassign : '';
    if (!USER_ID.test(userId) || !USER_ID.test(reassign)) {
      return render(res, site, { flash: { kind: 'error', message: 'Ongeldige gebruiker.' }, status: 422 });
    }
    if (req.body?.confirm !== 'on') {
      return render(res, site, { flash: { kind: 'error', message: 'Vink "definitief verwijderen" aan om te bevestigen.' }, status: 422 });
    }

    const actor = res.locals.auth!.user.email;
    try {
      const deleted = await deleteUser(clientFor(ctx, site), Number(userId), Number(reassign));
      db.audit(actor, 'wp_user_deleted', site.id, { id: deleted.id, username: deleted.username, reassign: Number(reassign) });
      res.redirect(303, `/sites/${site.id}/users?deleted=${encodeURIComponent(deleted.username)}`);
    } catch (err) {
      const message = userErrorMessage(err);
      db.audit(actor, 'wp_user_delete_failed', site.id, { id: Number(userId), error: message });
      await render(res, site, { flash: { kind: 'error', message: `Verwijderen mislukt: ${message}` }, status: 422 });
    }
  });

  return router;
}
