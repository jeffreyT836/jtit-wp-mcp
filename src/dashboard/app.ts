import express, { type NextFunction, type Request, type Response } from 'express';
import { SessionManager } from './auth/session.js';
import type { DashboardDeps, RouteContext } from './context.js';
import { apiRoutes } from './routes/api-routes.js';
import { authRoutes } from './routes/auth-routes.js';
import { siteRoutes } from './routes/site-routes.js';
import { updateRoutes } from './routes/update-routes.js';
import { userRoutes } from './routes/user-routes.js';
import { networkRoutes } from './routes/network-routes.js';
import { summarizeSite } from './snapshots.js';
import { APP_CSS, APP_JS, FAVICON_SVG } from './views/assets.js';
import type { NavData } from './views/layout.js';

const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function securityHeaders(secure: boolean) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // same-origin (not no-referrer): with no-referrer browsers send `Origin: null` on
    // same-site form posts, which the sameOrigin check must reject.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

/** Rejects cross-site form posts: a present Origin header must match the Host. */
function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');
  if (req.method === 'POST' && origin && origin !== 'null') {
    let host: string | undefined;
    try {
      host = new URL(origin).host;
    } catch {
      host = undefined;
    }
    if (host !== req.header('host')) {
      res.status(403).send('Cross-origin request geweigerd.');
      return;
    }
  } else if (req.method === 'POST' && origin === 'null') {
    res.status(403).send('Cross-origin request geweigerd.');
    return;
  }
  next();
}

/** Sidebar data (sites with status and open updates) for fully logged-in pages. */
function navData(ctx: RouteContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (res.locals.auth?.session.stage === 'full') {
      const snapshots = ctx.db.latestSnapshots();
      const sites = ctx.store.list().map((site) => {
        const status = summarizeSite(snapshots.filter((s) => s.site_id === site.id));
        const u = status.updates;
        return {
          id: site.id,
          name: site.name,
          state: !site.hasPassword || status.reachable === false ? ('error' as const) : status.reachable ? ('ok' as const) : ('unknown' as const),
          updates: u ? u.core + u.plugins + u.themes : 0,
          multisite: status.multisite === true,
        };
      });
      const nav: NavData = { path: req.path, sites };
      res.locals.nav = nav;
    }
    next();
  };
}


export function createDashboardApp(deps: DashboardDeps): express.Express {
  const app = express();
  const secure = deps.env.DASHBOARD_SECURE_COOKIES;
  const ctx: RouteContext = { ...deps, sessions: new SessionManager(deps.db, secure) };

  app.disable('x-powered-by');
  // Exactly one proxy hop (Traefik) in front; req.ip is then the real client IP.
  app.set('trust proxy', 1);
  app.use(securityHeaders(secure));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  // Asset URLs carry a content hash (?v=), so they can be cached for a year.
  const asset = (type: string, body: string) => (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(type).send(body);
  };
  app.get('/assets/app.css', asset('css', APP_CSS));
  app.get('/assets/app.js', asset('js', APP_JS));
  app.get('/assets/logo.svg', asset('svg', FAVICON_SVG));

  app.use('/api', apiRoutes(ctx));

  app.use(sameOrigin);
  app.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 500 }));
  app.use(ctx.sessions.load());
  app.use(navData(ctx));
  app.use(authRoutes(ctx));
  app.use(updateRoutes(ctx));
  app.use(userRoutes(ctx));
  app.use(networkRoutes(ctx));
  app.use(siteRoutes(ctx));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    process.stderr.write(
      `[wp-dashboard] request failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    if (!res.headersSent) res.status(500).type('text').send('Er ging iets mis. Probeer het opnieuw.');
  });

  return app;
}
