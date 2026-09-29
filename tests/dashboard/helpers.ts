import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import type { DashboardEnv } from '../../src/config/schema.js';
import { createDashboardApp } from '../../src/dashboard/app.js';
import { deriveTotpKey, totpAt } from '../../src/dashboard/auth/totp.js';
import { DashboardDb } from '../../src/dashboard/db.js';
import { seedAdmin } from '../../src/dashboard/seed-admin.js';
import { SiteStore } from '../../src/store/site-store.js';
import type { FetchLike } from '../../src/wp/client.js';

export const ADMIN = { ADMIN_EMAIL: 'admin@jtit.nl', ADMIN_PASSWORD: 'a very long admin password' };

/** Minimal cookie-keeping HTTP client for driving the dashboard like a browser. */
export class Browser {
  private cookie = '';
  constructor(private readonly base: string) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.base + path, {
      ...init,
      redirect: 'manual',
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(init.headers as Record<string, string>) },
    });
    for (const setCookie of res.headers.getSetCookie()) {
      const [pair] = setCookie.split(';');
      this.cookie = pair!.endsWith('=') ? '' : pair!;
    }
    return res;
  }

  get(path: string): Promise<Response> {
    return this.request(path);
  }

  post(path: string, form: Record<string, string | string[]>): Promise<Response> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
    }
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  }
}

export const csrfOf = (page: string): string => /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';

export interface TestApp {
  base: string;
  db: DashboardDb;
  store: SiteStore;
  close: () => Promise<void>;
}

export async function startApp(wpFetch: FetchLike, envOverrides: Partial<DashboardEnv> = {}): Promise<TestApp> {
  const key = randomBytes(32);
  const db = new DashboardDb(':memory:');
  const store = new SiteStore(':memory:', key);
  const env: DashboardEnv = {
    SITES_ENCRYPTION_KEY: key.toString('base64'),
    DASHBOARD_HOST: '127.0.0.1',
    DASHBOARD_PORT: 0,
    DASHBOARD_INGEST_TOKEN: 'i'.repeat(40),
    DASHBOARD_SECURE_COOKIES: false,
    WP_TIMEOUT_MS: 5000,
    WP_UPDATE_TIMEOUT_MS: 5000,
    ALERT_STALE_HOURS: 3,
    ...envOverrides,
  };
  await seedAdmin(ADMIN, db);
  const app = createDashboardApp({ db, store, env, totpKey: deriveTotpKey(key), fetch: wpFetch });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  return {
    base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`,
    db,
    store,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      store.close();
    },
  };
}

/** Logs in the seeded admin and enrols TOTP; returns a fully authenticated browser. */
export async function loginAndEnroll(base: string): Promise<Browser> {
  const browser = new Browser(base);
  await browser.post('/login', { email: ADMIN.ADMIN_EMAIL, password: ADMIN.ADMIN_PASSWORD });
  const setup = await (await browser.get('/login/totp-setup')).text();
  const secret = /<code class="secret">([A-Z2-7]+)<\/code>/.exec(setup)![1]!;
  const ok = await browser.post('/login/totp-setup', { _csrf: csrfOf(setup), code: totpAt(secret, Date.now()) });
  expect(ok.headers.get('location')).toBe('/');
  return browser;
}
