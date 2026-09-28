import type { Request, Response } from 'express';
import type { DashboardEnv } from '../config/schema.js';
import type { SiteStore } from '../store/site-store.js';
import type { FetchLike } from '../wp/client.js';
import type { SessionManager } from './auth/session.js';
import type { DashboardDb } from './db.js';
import { layout, type LayoutOptions } from './views/layout.js';

export interface DashboardDeps {
  db: DashboardDb;
  store: SiteStore;
  env: DashboardEnv;
  /** Key for TOTP secrets at rest (derived from SITES_ENCRYPTION_KEY). */
  totpKey: Buffer;
  /** Injectable for tests; forwarded to WpClient for connection tests. */
  fetch?: FetchLike;
}

export interface RouteContext extends DashboardDeps {
  sessions: SessionManager;
}

/** Client IP as seen through Traefik (`trust proxy` is set to the first hop). */
export const clientIp = (req: Request): string => req.ip ?? 'unknown';

/** Renders a page inside the layout, adding nav + CSRF when logged in. */
export function renderPage(
  res: Response,
  opts: Omit<LayoutOptions, 'user' | 'csrf' | 'nav'>,
  status = 200,
): void {
  const auth = res.locals.auth;
  const full = auth?.session.stage === 'full';
  res
    .status(status)
    .type('html')
    .send(
      layout({
        ...opts,
        user: full ? auth?.user.email : undefined,
        csrf: full ? auth?.session.csrf_token : undefined,
        nav: full ? res.locals.nav : undefined,
      }),
    );
}
