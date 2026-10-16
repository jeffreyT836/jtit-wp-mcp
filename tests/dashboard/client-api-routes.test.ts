import { afterEach, describe, expect, it } from 'vitest';
import { siteConfigSchema } from '../../src/config/schema.js';
import { VULN_KIND } from '../../src/vuln/items.js';
import { WordfenceFeed } from '../../src/vuln/wordfence.js';
import { createMockFetch, jsonResponse } from '../helpers/harness.js';
import { wordfenceFetch } from '../vuln/fixtures.js';
import { fixtureFeed, seedFixtureFleet } from './client-api-fixture.js';
import { csrfOf, loginAndEnroll, startApp, type TestApp } from './helpers.js';

const CLIENT_TOKEN = 'c'.repeat(40);
const auth = { authorization: `Bearer ${CLIENT_TOKEN}` };
const noWp = createMockFetch(() => jsonResponse({}, { status: 404 }));

describe('client API routes', () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('answers 503 on the whole prefix when no client token is configured', async () => {
    app = await startApp(noWp);
    for (const path of ['/client-api/v1/fleet', '/client-api/v1/sites/x', '/client-api/v1/anything']) {
      const res = await fetch(app.base + path, { headers: auth });
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ success: false, error: 'client api disabled' });
    }
  });

  it('requires the bearer token (not the ingest token, not a session)', async () => {
    app = await startApp(noWp, { env: { DASHBOARD_CLIENT_TOKEN: CLIENT_TOKEN } });
    for (const headers of [{}, { authorization: `Bearer ${'i'.repeat(40)}` }, { authorization: `Bearer ${CLIENT_TOKEN}x` }, { authorization: CLIENT_TOKEN }]) {
      const res = await fetch(`${app.base}/client-api/v1/fleet`, { headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, error: 'unauthorized' });
    }
    const browser = await loginAndEnroll(app.base);
    expect((await browser.get('/client-api/v1/fleet')).status).toBe(401);
  });

  it('serves only GET, and 404s for unknown sites and paths', async () => {
    app = await startApp(noWp, { env: { DASHBOARD_CLIENT_TOKEN: CLIENT_TOKEN } });
    const post = await fetch(`${app.base}/client-api/v1/fleet`, { method: 'POST', headers: auth });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    const unknown = await fetch(`${app.base}/client-api/v1/sites/bestaat-niet`, { headers: auth });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ success: false, error: 'unknown site "bestaat-niet"' });
    const path = await fetch(`${app.base}/client-api/v1/nope`, { headers: auth });
    expect(path.status).toBe(404);
    expect(await path.json()).toEqual({ success: false, error: 'not found' });
  });

  it('returns the fleet and single sites in the contract shape', async () => {
    const feed = await fixtureFeed();
    app = await startApp(noWp, { env: { DASHBOARD_CLIENT_TOKEN: CLIENT_TOKEN }, vulnFeed: feed });
    await seedFixtureFleet(app.store, app.db, feed);
    app.store.upsert(siteConfigSchema.parse({ id: 'nieuw', name: 'Nieuw', url: 'https://nieuw.nl', username: 'mcp-bot' }));

    const res = await fetch(`${app.base}/client-api/v1/fleet`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> & { sites: Array<Record<string, unknown>> } };
    expect(body.success).toBe(true);
    expect(Object.keys(body.data)).toEqual(['apiVersion', 'generatedAt', 'vulnerabilityFeed', 'summary', 'sites']);
    expect(body.data.apiVersion).toBe(1);
    expect(body.data.vulnerabilityFeed).toEqual({
      enabled: true, source: 'wordfence-intelligence-v3-production', updatedAt: '2026-10-16T06:00:00.000Z', records: 5, error: null,
    });
    expect(body.data.sites.map((s) => s.id)).toEqual(['klant-a', 'klant-b', 'klant-c', 'nieuw']);
    const site = body.data.sites[0]!;
    expect(Object.keys(site)).toEqual(['id', 'name', 'url', 'tags', 'hasPassword', 'multisite', 'state', 'issues', 'status', 'updates', 'vulnerabilities']);
    expect(site.state).toBe('critical');
    // The site without data has explicit nulls, not missing keys.
    const empty = body.data.sites[3]!;
    expect(empty.updates).toBeNull();
    expect(empty.vulnerabilities).toBeNull();
    expect(empty.status).toMatchObject({ collectedAt: null, reachable: null, error: null, updates: null, health: null });

    const one = await fetch(`${app.base}/client-api/v1/sites/klant-b`, { headers: auth });
    const single = (await one.json()) as { success: boolean; data: Record<string, unknown> };
    expect(single.success).toBe(true);
    expect(single.data).toEqual(body.data.sites[1]);
  });

  it('reports a disabled feed', async () => {
    app = await startApp(noWp, { env: { DASHBOARD_CLIENT_TOKEN: CLIENT_TOKEN } });
    const body = (await (await fetch(`${app.base}/client-api/v1/fleet`, { headers: auth })).json()) as { data: { vulnerabilityFeed: unknown; summary: unknown } };
    expect(body.data.vulnerabilityFeed).toEqual({ enabled: false, source: 'wordfence-intelligence-v3-production', updatedAt: null, records: null, error: null });
    expect(body.data.summary).toEqual({ sites: 0, ok: 0, warning: 0, critical: 0, unknown: 0, pendingUpdates: 0, vulnerabilities: 0, criticalVulnerabilities: 0 });
  });
});

const GOOD_PASS = 'good pass 1234';

/** Fake WordPress for the dashboard: login check + inventory for the scan. */
const wp = createMockFetch((url) => {
  const p = new URL(url).pathname;
  if (p.endsWith('/wp/v2/users/me')) return jsonResponse({ id: 1, username: 'mcp-bot', roles: ['administrator'] });
  if (p.endsWith('/nb-mcp/v1/status')) return jsonResponse({ bridge_version: '1.2.0', wp_version: '6.8.2' });
  if (p.endsWith('/wp/v2/plugins')) return jsonResponse([{ plugin: 'contact-form-7/wp-contact-form-7', name: 'Contact Form 7', version: '5.8.1' }]);
  if (p.endsWith('/wp/v2/themes')) return jsonResponse([{ stylesheet: 'astra', name: { rendered: 'Astra' }, version: '4.8.1' }]);
  return jsonResponse({}, { status: 404 });
});

describe('vulnerability panel and refresh route', () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const addSite = (t: TestApp, password: string | undefined = GOOD_PASS) =>
    t.store.upsert(siteConfigSchema.parse({ id: 'klant-a', name: 'Klant A', url: 'https://klant-a.nl', username: 'mcp-bot' }), password);

  it('explains that scanning is off without an API key and refuses the refresh', async () => {
    app = await startApp(wp);
    addSite(app);
    const browser = await loginAndEnroll(app.base);
    const page = await (await browser.get('/sites/klant-a')).text();
    expect(page).toContain('id="vulnerabilities"');
    expect(page).toContain('WORDFENCE_API_KEY');
    const res = await browser.post('/sites/klant-a/vulnerabilities/refresh', { _csrf: csrfOf(page) });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('De kwetsbaarhedenscan staat uit');
  });

  it('scans on demand (loading the feed first), audits and shows the matches with attribution', async () => {
    const wf = wordfenceFetch({ chunkSize: 3 });
    const feed = new WordfenceFeed({ apiKey: 'k'.repeat(20), fetch: wf.fetch, log: () => undefined });
    app = await startApp(wp, { vulnFeed: feed });
    addSite(app);
    const browser = await loginAndEnroll(app.base);
    const before = await (await browser.get('/sites/klant-a')).text();
    expect(before).toContain('Nog niet gescand');

    // CSRF is required.
    expect((await browser.post('/sites/klant-a/vulnerabilities/refresh', { _csrf: 'wrong' })).status).toBe(403);

    const res = await browser.post('/sites/klant-a/vulnerabilities/refresh', { _csrf: csrfOf(before) });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sites/klant-a?vulns=1#vulnerabilities');
    expect(wf.calls).toHaveLength(1);
    const audit = app.db.recentAudit().find((a) => a.action === 'vulnerabilities_checked');
    expect(audit?.target).toBe('klant-a');
    expect(JSON.parse(audit!.details!)).toEqual({ ok: true, items: 2 });

    const page = await (await browser.get('/sites/klant-a?vulns=1')).text();
    expect(page).toContain('Kwetsbaarheden opnieuw gecontroleerd.');
    expect(page).toContain('Contact Form 7 &lt;= 5.8.1 - Reflected Cross-Site Scripting');
    expect(page).toContain('href="https://www.cve.org/CVERecord?id=CVE-2024-1234"');
    expect(page).toContain('CVSS 8.1 · High');
    expect(page).toContain('Update to version 5.8.2, or a newer patched version');
    expect(page).toContain('WordPress Core &lt; 6.8.3 - Stored XSS');
    expect(page).not.toContain('Astra 4.0.0'); // 4.8.1 is not affected
    expect(page).toContain('Data: Wordfence Intelligence (Defiant Inc.) — CVE © The MITRE Corporation');
    expect(page).toContain('title="kwetsbaarheden">2</span>');

    const overview = await (await browser.get('/')).text();
    expect(overview).toContain('<th>Kwetsbaarheden</th>');
    expect(overview).toContain('1 kritiek');
  });

  it('shows a clean scan and refuses sites without a password', async () => {
    const feed = new WordfenceFeed({ apiKey: 'k'.repeat(20), fetch: wordfenceFetch({ body: '{}' }).fetch, log: () => undefined });
    app = await startApp(wp, { vulnFeed: feed });
    addSite(app);
    app.store.upsert(siteConfigSchema.parse({ id: 'zonder', name: 'Zonder', url: 'https://zonder.nl', username: 'mcp-bot' }));
    const browser = await loginAndEnroll(app.base);
    const page = await (await browser.get('/sites/klant-a')).text();
    expect((await browser.post('/sites/klant-a/vulnerabilities/refresh', { _csrf: csrfOf(page) })).status).toBe(303);
    expect(await (await browser.get('/sites/klant-a')).text()).toContain('Geen bekende kwetsbaarheden');
    const refused = await browser.post('/sites/zonder/vulnerabilities/refresh', { _csrf: csrfOf(page) });
    expect(refused.status).toBe(422);
    expect((await browser.post('/sites/bestaat-niet/vulnerabilities/refresh', { _csrf: csrfOf(page) })).headers.get('location')).toBe('/');
  });

  it('reports a feed that cannot be loaded', async () => {
    const feed = new WordfenceFeed({ apiKey: 'k'.repeat(20), fetch: wordfenceFetch({ status: 401 }).fetch, log: () => undefined });
    app = await startApp(wp, { vulnFeed: feed });
    addSite(app);
    const browser = await loginAndEnroll(app.base);
    const page = await (await browser.get('/sites/klant-a')).text();
    const res = await browser.post('/sites/klant-a/vulnerabilities/refresh', { _csrf: csrfOf(page) });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain('De Wordfence-feed is nog niet geladen: Wordfence weigert de API-sleutel (HTTP 401)');
    expect(app.db.latestSnapshots('klant-a').some((s) => s.kind === VULN_KIND)).toBe(false);
  });

  it('requires a full login', async () => {
    app = await startApp(wp);
    const res = await fetch(`${app.base}/sites/klant-a/vulnerabilities/refresh`, { method: 'POST', redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/login');
  });
});
