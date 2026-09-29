import { timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { RouteContext } from '../context.js';
import { ingestBodySchema, ingestedSiteIds, storeIngest } from '../snapshots.js';
import { evaluateAndNotify } from './alert-routes.js';

const INGEST_BODY_LIMIT = '1mb';

function bearer(token: string) {
  const expected = Buffer.from(token);
  return (req: Request, res: Response, next: NextFunction): void => {
    const match = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
    const provided = Buffer.from(match?.[1] ?? '');
    const ok = provided.length === expected.length && timingSafeEqual(provided, expected);
    if (!ok) {
      res.status(401).json({ success: false, error: 'unauthorized' });
      return;
    }
    next();
  };
}

/**
 * Machine API for n8n. Not routed publicly by Traefik (see docker-compose.prod.yml); n8n
 * reaches it on the internal Docker network as http://wp-dashboard:3001/api/...
 */
export function apiRoutes(ctx: RouteContext): Router {
  const router = Router();
  router.use(bearer(ctx.env.DASHBOARD_INGEST_TOKEN));
  router.use(express.json({ limit: INGEST_BODY_LIMIT }));

  router.post('/ingest', async (req, res) => {
    const parsed = ingestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        success: false,
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      return;
    }
    const knownIds = new Set(ctx.store.list().map((s) => s.id));
    if (parsed.data.site && !knownIds.has(parsed.data.site)) {
      res.status(404).json({ success: false, error: `unknown site "${parsed.data.site}"` });
      return;
    }
    const stored = storeIngest(ctx.db, parsed.data, knownIds);
    const changes = await evaluateAndNotify(ctx, parsed.data.kind, ingestedSiteIds(parsed.data, knownIds));
    res.json({
      success: true,
      data: {
        stored,
        alerts: {
          opened: changes.filter((c) => c.change === 'opened').length,
          resolved: changes.filter((c) => c.change === 'resolved').length,
        },
      },
    });
  });

  /** Lets n8n discover which sites exist (no secrets). */
  router.get('/sites', (_req, res) => {
    res.json({
      success: true,
      data: ctx.store.list().map(({ id, name, url, tags, readOnly, bridge, hasPassword }) => ({
        id, name, url, tags, readOnly, bridge, hasPassword,
      })),
    });
  });

  return router;
}
