import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDashboardApp } from '../../src/dashboard/app.js';
import { deriveTotpKey, totpAt } from '../../src/dashboard/auth/totp.js';
import { DashboardDb } from '../../src/dashboard/db.js';
import { seedAdmin } from '../../src/dashboard/seed-admin.js';
import type { DashboardEnv } from '../../src/config/schema.js';
import { SiteStore } from '../../src/store/site-store.js';
import { createMockFetch, jsonResponse } from '../helpers/harness.js';

const ADMIN = { ADMIN_EMAIL: 'admin@jtit.nl', ADMIN_PASSWORD: 'a very long admin password' };
const INGEST_TOKEN = 'i'.repeat(40);
const GOOD_APP_PASSWORD = 'good pass 1234';

/** Fake WordPress: accepts GOOD_APP_PASSWORD, returns an administrator + bridge status. */
const wpFetch = createMockFetch((url, init) => {
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  const [, b64 = ''] = auth.split(' ');
  const [, pass] = Buffer.from(b64, 'base64').toString().split(':');
  if (pass !== GOOD_APP_PASSWORD) {
    return jsonResponse({ code: 'incorrect_password', message: 'bad password', data: { status: 401 } }, { status: 401 });
  }
  if (url.includes('/wp/v2/users/me')) return jsonResponse({ id: 1, username: 'mcp-bot', roles: ['administrator'] });
  if (url.includes('/nb-mcp/v1/status')) return jsonResponse({ bridge_version: '1.0', wp_version: '6.8' });
  return jsonResponse({}, { status: 404 });
});

class Browser {
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

  get(path: string) {
    return this.request(path);
  }

  post(path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(form).toString(),
    });
  }
}

const csrfOf = (page: string) => /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';

describe('dashboard app', () => {
  let server: Server;
  let base: string;
  let db: DashboardDb;
  let store: SiteStore;

  beforeEach(async () => {
    const key = randomBytes(32);
    db = new DashboardDb(':memory:');
    store = new SiteStore(':memory:', key);
    const env: DashboardEnv = {
      SITES_ENCRYPTION_KEY: key.toString('base64'),
      DASHBOARD_HOST: '127.0.0.1',
      DASHBOARD_PORT: 0,
      DASHBOARD_INGEST_TOKEN: INGEST_TOKEN,
      DASHBOARD_SECURE_COOKIES: false,
      WP_TIMEOUT_MS: 5000,
      WP_UPDATE_TIMEOUT_MS: 5000,
    };
    await seedAdmin(ADMIN, db);
    const app = createDashboardApp({ db, store, env, totpKey: deriveTotpKey(key), fetch: wpFetch });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    store.close();
  });

  /** Logs in and enrols TOTP; returns the browser plus the TOTP secret. */
  async function loginAndEnroll(): Promise<{ browser: Browser; secret: string }> {
    const browser = new Browser(base);
    const login = await browser.post('/login', { email: ADMIN.ADMIN_EMAIL, password: ADMIN.ADMIN_PASSWORD });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/login/totp-setup');
    const setup = await (await browser.get('/login/totp-setup')).text();
    expect(setup).toContain('<svg');
    const secret = /<code class="secret">([A-Z2-7]+)<\/code>/.exec(setup)![1]!;
    const bad = await browser.post('/login/totp-setup', { _csrf: csrfOf(setup), code: '000000' });
    expect(bad.status).toBe(401);
    const ok = await browser.post('/login/totp-setup', { _csrf: csrfOf(setup), code: totpAt(secret, Date.now()) });
    expect(ok.headers.get('location')).toBe('/');
    return { browser, secret };
  }

  it('sets security headers and serves css + healthz', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    // no-referrer would make browsers send `Origin: null` on our own form posts.
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect((await fetch(`${base}/assets/app.css`)).headers.get('content-type')).toContain('text/css');
  });

  it('serves content-versioned, long-cached assets and a logo', async () => {
    const login = await (await fetch(`${base}/login`)).text();
    const version = /href="\/assets\/app\.css\?v=([0-9a-f]{12})"/.exec(login)?.[1];
    expect(version).toBeDefined();
    expect(login).toContain(`src="/assets/app.js?v=${version}"`);
    expect(login).toContain('class="logo-mark"');
    const css = await fetch(`${base}/assets/app.css?v=${version}`);
    expect(css.headers.get('cache-control')).toContain('immutable');
    const logo = await fetch(`${base}/assets/logo.svg`);
    expect(logo.headers.get('content-type')).toContain('image/svg+xml');
    expect(await logo.text()).toContain('#FF005E');
  });

  it('redirects anonymous users to login and rejects bad credentials generically', async () => {
    const browser = new Browser(base);
    expect((await browser.get('/')).headers.get('location')).toBe('/login');
    expect((await browser.get('/sites/new')).headers.get('location')).toBe('/login');
    const wrong = await browser.post('/login', { email: ADMIN.ADMIN_EMAIL, password: 'nope nope nope' });
    const unknown = await browser.post('/login', { email: 'x@y.nl', password: 'nope nope nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toContain('Onjuiste inloggegevens.');
    expect(db.recentAudit().filter((a) => a.action === 'login_failed')).toHaveLength(2);
  });

  it('locks the account after 5 failed attempts', async () => {
    const browser = new Browser(base);
    for (let i = 0; i < 5; i++) {
      await browser.post('/login', { email: ADMIN.ADMIN_EMAIL, password: 'wrong wrong wrong' });
    }
    const locked = await browser.post('/login', { email: ADMIN.ADMIN_EMAIL, password: ADMIN.ADMIN_PASSWORD });
    expect(locked.status).toBe(401);
    expect(db.userByEmail(ADMIN.ADMIN_EMAIL)?.locked_until).toBeTruthy();
  });

  it('enrols TOTP, then requires it on the next login', async () => {
    const { secret } = await loginAndEnroll();
    const browser = new Browser(base);
    const login = await browser.post('/login', { email: ADMIN.ADMIN_EMAIL, password: ADMIN.ADMIN_PASSWORD });
    expect(login.headers.get('location')).toBe('/login/totp');
    expect((await browser.get('/')).headers.get('location')).toBe('/login/totp');
    const page = await (await browser.get('/login/totp')).text();
    expect((await browser.post('/login/totp', { _csrf: csrfOf(page), code: '000000' })).status).toBe(401);
    const ok = await browser.post('/login/totp', { _csrf: csrfOf(page), code: totpAt(secret, Date.now()) });
    expect(ok.headers.get('location')).toBe('/');
    expect((await browser.get('/')).status).toBe(200);
  });

  it('adds a site only after a successful connection test and never renders the password', async () => {
    const { browser } = await loginAndEnroll();
    const form = await (await browser.get('/sites/new')).text();
    const fields = {
      _csrf: csrfOf(form),
      id: 'klant-a',
      name: 'Klant <A>',
      url: 'https://klant-a.nl',
      wp_user: 'mcp-bot',
      tags: 'prod, woo',
      bridge: 'on',
    };

    expect(form).toContain('name="wp_user"');
    expect(form).toContain('name="app_password"');
    expect(form).not.toMatch(/name="(username|password)"/);
    const failed = await browser.post('/sites', { ...fields, app_password: 'wrong password' });
    expect(failed.status).toBe(422);
    const failedHtml = await failed.text();
    expect(failedHtml).toContain('Application Password klopt niet');
    expect(failedHtml).not.toContain('wrong password');
    expect(failedHtml).toContain('Klant &lt;A&gt;');
    expect(store.list()).toEqual([]);

    const saved = await browser.post('/sites', { ...fields, app_password: GOOD_APP_PASSWORD });
    expect(saved.headers.get('location')).toBe('/sites/klant-a?saved=1');
    expect(store.load()[0]).toMatchObject({ id: 'klant-a', password: GOOD_APP_PASSWORD, tags: ['prod', 'woo'] });

    const detail = await (await browser.get('/sites/klant-a?saved=1')).text();
    expect(detail).toContain('Site opgeslagen en verbinding getest.');
    const edit = await (await browser.get('/sites/klant-a/edit')).text();
    for (const page of [detail, edit, await (await browser.get('/')).text()]) {
      expect(page).not.toContain(GOOD_APP_PASSWORD);
    }

    // Editing without a password keeps the stored one.
    expect(edit).toContain('Opgeslagen: <code>mcp-bot</code>');
    const updated = await browser.post('/sites/klant-a', { ...fields, _csrf: csrfOf(edit), name: 'Klant A', app_password: '' });
    expect(updated.status).toBe(303);
    expect(store.load()[0]).toMatchObject({ name: 'Klant A', password: GOOD_APP_PASSWORD });

    const tested = await browser.post('/sites/klant-a/test', { _csrf: csrfOf(edit) });
    expect(await tested.text()).toContain('Verbinding OK als mcp-bot');

    expect((await browser.post('/sites/klant-a/delete', { _csrf: csrfOf(edit) })).headers.get('location')).toBe('/sites/klant-a');
    expect(store.list()).toHaveLength(1);
    await browser.post('/sites/klant-a/delete', { _csrf: csrfOf(edit), confirm: 'on' });
    expect(store.list()).toEqual([]);

    const actions = db.recentAudit().map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['site_created', 'site_updated', 'site_tested', 'site_deleted']));
    expect(JSON.stringify(db.recentAudit())).not.toContain(GOOD_APP_PASSWORD);
  });

  it('can save despite a failed test only when explicitly confirmed', async () => {
    const { browser } = await loginAndEnroll();
    const form = await (await browser.get('/sites/new')).text();
    const res = await browser.post('/sites', {
      _csrf: csrfOf(form), id: 'klant-b', name: 'B', url: 'https://b.nl', wp_user: 'mcp-bot', app_password: 'wrong', skipTest: 'on',
    });
    expect(res.headers.get('location')).toBe('/sites/klant-b?saved=1&untested=1');
    expect(store.list()).toHaveLength(1);
  });

  it('rejects posts without CSRF token or from another origin', async () => {
    const { browser } = await loginAndEnroll();
    expect((await browser.post('/sites', { id: 'x' })).status).toBe(403);
    const form = await (await browser.get('/sites/new')).text();
    const cross = await browser.post('/sites', { _csrf: csrfOf(form), id: 'x' }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    const nullOrigin = await browser.post('/sites', { _csrf: csrfOf(form), id: 'x' }, { origin: 'null' });
    expect(nullOrigin.status).toBe(403);
    const sameOrigin = await browser.post('/sites', { _csrf: csrfOf(form), id: 'x' }, { origin: base });
    expect(sameOrigin.status).toBe(422);
  });

  it('logs out and resets TOTP enrolment on request', async () => {
    const { browser } = await loginAndEnroll();
    const settings = await (await browser.get('/settings')).text();
    expect(settings).toContain(ADMIN.ADMIN_EMAIL);
    const reset = await browser.post('/settings/totp-reset', { _csrf: csrfOf(settings), confirm: 'on' });
    expect(reset.headers.get('location')).toBe('/login/totp-setup');
    expect((await browser.get('/')).headers.get('location')).toBe('/login/totp-setup');
    const setup = await (await browser.get('/login/totp-setup')).text();
    await browser.post('/logout', { _csrf: csrfOf(setup) });
    expect((await browser.get('/')).headers.get('location')).toBe('/login');
  });

  it('ingests n8n data with the bearer token and shows it', async () => {
    store.upsert({ id: 'klant-a', name: 'Klant A', url: 'https://klant-a.nl', username: 'mcp-bot' }, GOOD_APP_PASSWORD);
    const post = (body: unknown, token = INGEST_TOKEN) =>
      fetch(`${base}/api/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ kind: 'fleet_health', data: {} }, 'wrong')).status).toBe(401);
    expect((await post({ kind: 'Bad Kind', data: {} })).status).toBe(422);
    expect((await post({ kind: 'site_info', site: 'nope', data: {} })).status).toBe(404);
    const ok = await post({
      kind: 'fleet_health',
      data: { results: [{ site: 'klant-a', ok: true, data: { ok: true, roles: ['administrator'], bridge: 'ok', versions: { wp_version: '6.8.1' } } }] },
    });
    expect(await ok.json()).toEqual({ success: true, data: { stored: 2 } });

    const sites = await fetch(`${base}/api/sites`, { headers: { authorization: `Bearer ${INGEST_TOKEN}` } });
    expect(JSON.stringify(await sites.json())).not.toContain(GOOD_APP_PASSWORD);

    const { browser } = await loginAndEnroll();
    const overview = await (await browser.get('/')).text();
    expect(overview).toContain('6.8.1');
    expect(overview).toContain('bereikbaar');
    // Sidebar: every site with its status dot; tiles count up from real numbers.
    expect(overview).toMatch(/class="nav-site"[^>]*href="\/sites\/klant-a"|href="\/sites\/klant-a"[^>]*>\s*<span class="dot ok"/);
    expect(overview).toContain('data-count="1"');
    const detail = await (await browser.get('/sites/klant-a')).text();
    expect(detail).toMatch(/class="nav-site active" href="\/sites\/klant-a" aria-current="page"/);
    expect(detail).toMatch(/<details class="panel" id="updates" data-persist="updates" open>/);
    expect(detail).toMatch(/<details class="panel panel-danger" id="danger" data-persist="danger" >/);
    expect(await (await browser.get('/audit')).text()).toContain('totp_enrolled');
  });

  it('seedAdmin is idempotent and logs out sessions on password change', async () => {
    expect(await seedAdmin(ADMIN, db)).toContain('unchanged');
    const { browser } = await loginAndEnroll();
    expect(await seedAdmin({ ...ADMIN, ADMIN_PASSWORD: 'another long password' }, db)).toContain('password updated');
    expect((await browser.get('/')).headers.get('location')).toBe('/login');
    await expect(seedAdmin({ ADMIN_EMAIL: 'bad', ADMIN_PASSWORD: 'x' }, db)).rejects.toThrow();
  });
});
