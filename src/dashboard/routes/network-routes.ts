import { Router, type Request } from 'express';
import type { ResolvedSite } from '../../config/schema.js';
import { getNetworkSite, listNetworkSites } from '../../wp/network.js';
import { fetchSiteHealth } from '../../wp/site-health.js';
import { requireCsrf, requireFullAuth } from '../auth/session.js';
import { renderPage, type RouteContext } from '../context.js';
import { bridgeErrorMessage, HEALTH_KIND, healthSnapshotPayload } from '../health.js';
import { userErrorMessage } from '../users.js';
import { networkPage, networkSitePage } from '../views/network-views.js';
import { clientFor, renderSiteDetail } from './site-routes.js';

const BLOG_ID = /^[1-9][0-9]{0,9}$/;

/** Multisite network pages and the Site Health refresh. All data is fetched live. */
export function networkRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, store } = ctx;

  router.use(['/sites/:id/network', '/sites/:id/health'], requireFullAuth);

  const loadSite = (req: Request): ResolvedSite | undefined => store.load().find((s) => s.id === req.params.id);
  const stored = (id: string) => store.list().find((s) => s.id === id)!;
  const unavailable = (site: ResolvedSite) =>
    !site.available ? (site.unavailableReason ?? 'site is niet beschikbaar') : !site.bridge ? 'Multisite-beheer vereist de nb-mcp-bridge.' : undefined;

  router.get('/sites/:id/network', async (req, res) => {
    const site = loadSite(req);
    if (!site) return res.redirect(303, '/');
    const reason = unavailable(site);
    let body;
    if (reason) body = networkPage({ site: stored(site.id), error: reason });
    else {
      try {
        body = networkPage({ site: stored(site.id), overview: await listNetworkSites(clientFor(ctx, site)) });
      } catch (err) {
        body = networkPage({ site: stored(site.id), error: bridgeErrorMessage(err) });
      }
    }
    renderPage(res, { title: `Multisite · ${site.name}`, body });
  });

  router.get('/sites/:id/network/:blogId', async (req, res) => {
    const site = loadSite(req);
    if (!site) return res.redirect(303, '/');
    const raw = String(req.params.blogId);
    if (!BLOG_ID.test(raw)) return res.redirect(303, `/sites/${site.id}/network`);
    const blogId = Number(raw);
    const reason = unavailable(site);
    let body;
    if (reason) body = networkSitePage({ site: stored(site.id), blogId, error: reason });
    else {
      try {
        body = networkSitePage({ site: stored(site.id), blogId, detail: await getNetworkSite(clientFor(ctx, site), blogId) });
      } catch (err) {
        body = networkSitePage({ site: stored(site.id), blogId, error: userErrorMessage(err) });
      }
    }
    renderPage(res, { title: `Subsite ${blogId} · ${site.name}`, body });
  });

  /** Live Site Health (with directory sizes) stored as a snapshot, like n8n does. */
  router.post('/sites/:id/health/refresh', requireCsrf, async (req, res) => {
    const site = loadSite(req);
    if (!site) return res.redirect(303, '/');
    const reason = !site.available ? (site.unavailableReason ?? 'site is niet beschikbaar') : !site.bridge ? 'Site Health vereist de nb-mcp-bridge.' : undefined;
    if (reason) return renderSiteDetail(ctx, res, stored(site.id), { kind: 'error', message: reason }, 422);
    let ok = true;
    try {
      const data = await fetchSiteHealth(clientFor(ctx, site), { includeSizes: true });
      db.insertSnapshot(site.id, HEALTH_KIND, healthSnapshotPayload(site.id, { data }), new Date().toISOString());
    } catch (err) {
      ok = false;
      db.insertSnapshot(site.id, HEALTH_KIND, healthSnapshotPayload(site.id, { error: bridgeErrorMessage(err) }), new Date().toISOString());
    }
    db.audit(res.locals.auth!.user.email, 'site_health_checked', site.id, { ok });
    res.redirect(303, `/sites/${site.id}?health=1#health`);
  });

  return router;
}
