import { Router } from 'express';
import { siteIdSchema } from '../../config/schema.js';
import { bearer } from '../auth/bearer.js';
import { buildFleetView, buildSiteView } from '../client-api.js';
import type { RouteContext } from '../context.js';

/**
 * Read-only client API v1 for the macOS menubar app (docs/CLIENT-API.md). Public via Traefik,
 * bearer `DASHBOARD_CLIENT_TOKEN` only: no cookies, no CSRF, GET only.
 */
export function clientApiRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, store } = ctx;
  const token = ctx.env.DASHBOARD_CLIENT_TOKEN;

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  if (!token) {
    router.use((_req, res) => {
      res.status(503).json({ success: false, error: 'client api disabled' });
    });
    return router;
  }
  router.use(bearer(token));
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).setHeader('Allow', 'GET').json({ success: false, error: 'method not allowed' });
      return;
    }
    next();
  });

  router.get('/fleet', (_req, res) => {
    const data = buildFleetView({ sites: store.list(), snapshots: db.latestSnapshots(), feed: ctx.vulnFeed.status(), now: new Date() });
    res.json({ success: true, data });
  });

  router.get('/sites/:id', (req, res) => {
    const site = store.list().find((s) => s.id === req.params.id);
    if (!site) {
      // Only echo ids that look like site ids; never reflect arbitrary input.
      const id = String(req.params.id);
      const error = siteIdSchema.safeParse(id).success ? `unknown site "${id}"` : 'unknown site';
      res.status(404).json({ success: false, error });
      return;
    }
    res.json({ success: true, data: buildSiteView(site, db.latestSnapshots(site.id), new Date()) });
  });

  router.use((_req, res) => {
    res.status(404).json({ success: false, error: 'not found' });
  });

  return router;
}
