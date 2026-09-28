import { Router, type Request, type Response } from 'express';
import { resolveSite } from '../../config/loader.js';
import { siteConfigSchema, type ResolvedSite, type SiteConfig } from '../../config/schema.js';
import { checkSite } from '../../tools/sites.js';
import { WpClient } from '../../wp/client.js';
import { sanitizeMessage } from '../../wp/errors.js';
import { requireCsrf, requireFullAuth } from '../auth/session.js';
import { renderPage, type RouteContext } from '../context.js';
import { summarizeSite } from '../snapshots.js';
import {
  auditPage,
  emptySiteForm,
  overviewPage,
  settingsPage,
  siteDetailPage,
  siteFormPage,
  type SiteFormValues,
} from '../views/site-pages.js';

export interface ConnectionResult {
  ok: boolean;
  message: string;
}

/** Tests credentials against the live site: authenticated, administrator, bridge status. */
export async function testConnection(ctx: RouteContext, site: ResolvedSite): Promise<ConnectionResult> {
  if (!site.available) return { ok: false, message: site.unavailableReason ?? 'site is niet beschikbaar' };
  try {
    const client = new WpClient(site, { fetch: ctx.fetch, defaultTimeoutMs: ctx.env.WP_TIMEOUT_MS });
    const result = await checkSite(client, site);
    if (!result.ok) return { ok: false, message: `Inloggen mislukt: ${result.error ?? 'onbekende fout'}` };
    if (!result.isAdmin) {
      return { ok: false, message: `Gebruiker "${result.user?.username}" is geen administrator; updates zullen falen.` };
    }
    const bridge = site.bridge ? ` Bridge: ${result.bridge}.` : '';
    return { ok: true, message: `Verbinding OK als ${result.user?.username}.${bridge}` };
  } catch (err) {
    return { ok: false, message: sanitizeMessage(err instanceof Error ? err.message : String(err)) };
  }
}

function formValues(body: Record<string, unknown>): SiteFormValues {
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  return {
    id: s('id'),
    name: s('name'),
    url: s('url'),
    username: s('username'),
    tags: s('tags'),
    readOnly: body.readOnly === 'on',
    allowHttp: body.allowHttp === 'on',
    bridge: body.bridge === 'on',
  };
}

function toFormValues(site: SiteConfig): SiteFormValues {
  return { ...site, tags: site.tags.join(', ') };
}

export function siteRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, store } = ctx;
  router.use(requireFullAuth);

  router.get('/', (_req, res) => {
    const snapshots = db.latestSnapshots();
    const rows = store.list().map((site) => ({
      site,
      status: summarizeSite(snapshots.filter((s) => s.site_id === site.id)),
    }));
    renderPage(res, { title: 'Overzicht', body: overviewPage(rows) });
  });

  router.get('/sites/new', (_req, res) => {
    renderPage(res, {
      title: 'Site toevoegen',
      body: siteFormPage({ csrf: res.locals.auth!.session.csrf_token, values: emptySiteForm, mode: 'create' }),
    });
  });

  /** Shared create/update handler: validate → (test) → save → audit. */
  const save = (mode: 'create' | 'edit') => async (req: Request, res: Response) => {
    const auth = res.locals.auth!;
    const submitted = formValues(req.body ?? {});
    const values = mode === 'edit' ? { ...submitted, id: String(req.params.id) } : submitted;
    const existing = store.list().find((s) => s.id === values.id);
    const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
    const rerender = (error: string, offerSkipTest = false, status = 422) =>
      renderPage(
        res,
        {
          title: mode === 'create' ? 'Site toevoegen' : 'Site bewerken',
          body: siteFormPage({ csrf: auth.session.csrf_token, values, mode, hasPassword: existing?.hasPassword, error, offerSkipTest }),
        },
        status,
      );

    if (mode === 'create' && existing) return rerender(`Er bestaat al een site met id "${values.id}".`);
    if (mode === 'edit' && !existing) return res.redirect(303, '/');
    const parsed = siteConfigSchema.safeParse({
      ...values,
      tags: values.tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    if (!parsed.success) {
      return rerender(parsed.error.issues.map((i) => `${i.path.join('.') || 'site'}: ${i.message}`).join('; '));
    }
    if (mode === 'create' && password === '') return rerender('Application Password is verplicht.');

    const currentPassword =
      password !== '' ? password : (store.load().find((s) => s.id === values.id)?.password ?? null);
    const test = await testConnection(ctx, resolveSite(parsed.data, currentPassword));
    if (!test.ok && req.body?.skipTest !== 'on') {
      return rerender(`${test.message} Vul het wachtwoord opnieuw in om het nog eens te proberen.`, true);
    }

    store.upsert(parsed.data, password !== '' ? password : undefined);
    db.audit(auth.user.email, mode === 'create' ? 'site_created' : 'site_updated', values.id, {
      passwordChanged: password !== '',
      connectionTest: test.ok ? 'ok' : 'skipped_after_failure',
    });
    res.redirect(303, `/sites/${values.id}?saved=1${test.ok ? '' : '&untested=1'}`);
  };

  router.post('/sites', requireCsrf, save('create'));
  router.post('/sites/:id', requireCsrf, save('edit'));

  const findSite = (id: string) => store.list().find((s) => s.id === id);

  router.get('/sites/:id', (req, res) => {
    const site = findSite(req.params.id);
    if (!site) return res.redirect(303, '/');
    const snapshots = db.latestSnapshots(site.id);
    const flash = req.query.saved
      ? req.query.untested
        ? { kind: 'error' as const, message: 'Opgeslagen, maar de verbindingstest was niet geslaagd.' }
        : { kind: 'ok' as const, message: 'Site opgeslagen en verbinding getest.' }
      : undefined;
    renderPage(res, {
      title: site.name,
      flash,
      body: siteDetailPage({
        csrf: res.locals.auth!.session.csrf_token,
        site,
        status: summarizeSite(snapshots),
        snapshots,
        audit: db.recentAudit(500).filter((a) => a.target === site.id).slice(0, 20),
      }),
    });
  });

  router.get('/sites/:id/edit', (req, res) => {
    const site = findSite(req.params.id);
    if (!site) return res.redirect(303, '/');
    renderPage(res, {
      title: 'Site bewerken',
      body: siteFormPage({ csrf: res.locals.auth!.session.csrf_token, values: toFormValues(site), mode: 'edit', hasPassword: site.hasPassword }),
    });
  });

  router.post('/sites/:id/test', requireCsrf, async (req, res) => {
    const site = store.load().find((s) => s.id === req.params.id);
    if (!site) return res.redirect(303, '/');
    const result = await testConnection(ctx, site);
    db.audit(res.locals.auth!.user.email, 'site_tested', site.id, { ok: result.ok });
    const stored = findSite(site.id)!;
    const snapshots = db.latestSnapshots(site.id);
    renderPage(res, {
      title: site.name,
      flash: { kind: result.ok ? 'ok' : 'error', message: result.message },
      body: siteDetailPage({
        csrf: res.locals.auth!.session.csrf_token,
        site: stored,
        status: summarizeSite(snapshots),
        snapshots,
        audit: db.recentAudit(500).filter((a) => a.target === site.id).slice(0, 20),
      }),
    });
  });

  router.post('/sites/:id/delete', requireCsrf, (req, res) => {
    const id = String(req.params.id);
    if (req.body?.confirm === 'on' && store.remove(id)) {
      db.audit(res.locals.auth!.user.email, 'site_deleted', id);
      return res.redirect(303, '/');
    }
    res.redirect(303, `/sites/${encodeURIComponent(id)}`);
  });

  router.get('/audit', (_req, res) => {
    renderPage(res, { title: 'Audit-log', body: auditPage(db.recentAudit()) });
  });

  router.get('/settings', (_req, res) => {
    const auth = res.locals.auth!;
    const lastIngest = db.lastSnapshotReceivedAt();
    renderPage(res, {
      title: 'Instellingen',
      body: settingsPage({ csrf: auth.session.csrf_token, email: auth.user.email, ingestLastSeen: lastIngest }),
    });
  });

  return router;
}
