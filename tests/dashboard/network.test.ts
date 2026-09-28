import { afterEach, describe, expect, it } from 'vitest';
import { latestHealth } from '../../src/dashboard/health.js';
import { createMockFetch, jsonResponse } from '../helpers/harness.js';
import { csrfOf, loginAndEnroll, startApp, type TestApp } from './helpers.js';

const SECRET = 'Zeer-Geheim-Wachtwoord-42!';

interface BlogUser { id: number; username: string; name: string; email: string; roles: string[]; registered_date: string; super_admin?: boolean }

const HEALTH = {
  checked_at: '2026-09-28T10:00:00Z',
  summary: { critical: 1, recommended: 1, good: 1 },
  tests: [
    {
      test: 'php_version', label: 'Je site draait op een <verouderde> PHP-versie', status: 'critical', badge: { label: 'Beveiliging', color: 'red' },
      description: 'PHP 7.4 wordt niet meer ondersteund.\nWerk PHP bij.',
      actions: [{ label: 'Meer over PHP bijwerken', url: 'https://wordpress.org/support/update-php/' }, { label: 'kwaad', url: 'javascript:alert(1)' }],
    },
    { test: 'persistent_object_cache', label: 'Gebruik een object cache', status: 'recommended', badge: { label: 'Prestaties', color: 'blue' }, description: 'Redis helpt.', actions: [] },
    { test: 'https_status', label: 'Je site gebruikt HTTPS', status: 'good', badge: { label: 'Beveiliging', color: 'blue' }, description: '', actions: [] },
  ],
  info: { wp_version: '6.8.3', php_version: '7.4.33', object_cache: false, https: true, sizes: { total_size: { size: '1,2 GB', raw: 1 } } },
};

/** Fake multisite network: main blog 1 + subsite 2, users per blog, Site Health. */
function fakeNetwork(opts: { multisite?: boolean; features?: string[] } = {}) {
  const multisite = opts.multisite ?? true;
  const features = opts.features ?? ['safe_updates', 'site_health', 'network'];
  const blogs: Record<number, BlogUser[]> = {
    1: [
      { id: 1, username: 'mcpbot', name: 'MCP', email: 'bot@x.nl', roles: ['administrator'], registered_date: '2026-01-01T00:00:00Z', super_admin: true },
      { id: 5, username: 'hoofdredactie', name: 'Hoofd', email: 'h@x.nl', roles: ['editor'], registered_date: '2026-01-01T00:00:00Z' },
    ],
    2: [
      { id: 1, username: 'mcpbot', name: 'MCP', email: 'bot@x.nl', roles: ['administrator'], registered_date: '2026-01-01T00:00:00Z', super_admin: true },
      { id: 7, username: 'janvries', name: 'Jan <b>de Vries</b>', email: 'jan@x.nl', roles: ['editor'], registered_date: '2026-02-01T00:00:00Z' },
    ],
  };
  const calls: string[] = [];
  const bodies: string[] = [];
  const fetch = createMockFetch(async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${p}`);
    if (init?.body) bodies.push(String(init.body));
    if (p.endsWith('/nb-mcp/v1/status')) return jsonResponse({ bridge_version: features.includes('network') ? '1.2.0' : '1.1.0', features, multisite, main_site_id: multisite ? 1 : null });
    if (p.endsWith('/nb-mcp/v1/site-health')) return jsonResponse(HEALTH);
    if (p.endsWith('/nb-mcp/v1/network/sites')) {
      return jsonResponse(multisite
        ? { multisite: true, network: { name: 'Netwerk', domain: 'klant-a.nl', main_site_id: 1 }, total: 2, sites: [
            { blog_id: 1, name: 'Hoofdsite', url: 'https://klant-a.nl', domain: 'klant-a.nl', path: '/', registered: '2024-01-01 10:00:00', last_updated: '2026-09-01 10:00:00', public: true, archived: false, deleted: false, spam: false, is_main: true },
            { blog_id: 2, name: 'Winkel <NL>', url: 'https://klant-a.nl/winkel/', domain: 'klant-a.nl', path: '/winkel/', registered: '2025-01-01 10:00:00', last_updated: '2026-09-02 10:00:00', public: false, archived: true, deleted: false, spam: false, is_main: false },
          ] }
        : { multisite: false, network: null, total: 0, sites: [] });
    }
    const m = /\/nb-mcp\/v1\/network\/sites\/(\d+)(\/.*)?$/.exec(p);
    if (m) {
      const blog = Number(m[1]);
      const rest = m[2] ?? '';
      if (!blogs[blog]) return jsonResponse({ code: 'nb_mcp_site_not_found', message: 'No site' }, { status: 404 });
      if (rest === '') {
        return jsonResponse({ blog_id: blog, name: blog === 2 ? 'Winkel <NL>' : 'Hoofdsite', url: 'https://klant-a.nl/winkel/', domain: 'klant-a.nl', path: '/winkel/', registered: '2025-01-01 10:00:00', last_updated: '2026-09-02 10:00:00', public: false, archived: true, deleted: false, spam: false, is_main: blog === 1,
          admin_email: 'winkel@x.nl', language: 'nl_NL', theme: { stylesheet: 'astra', name: 'Astra', version: '4.1' },
          plugins: [{ plugin: 'woocommerce/woocommerce.php', name: 'WooCommerce', version: '10.2', network: false }, { plugin: 'akismet/akismet.php', name: 'Akismet', version: '5.3', network: true }],
          counts: { posts: 12, pages: 4, users: blogs[blog]!.length } });
      }
      if (rest === '/roles') return jsonResponse({ roles: [{ slug: 'administrator', name: 'Beheerder' }, { slug: 'editor', name: 'Redacteur' }, { slug: 'shop_manager', name: 'Winkelmanager' }] });
      if (rest === '/users' && method === 'GET') return jsonResponse({ blog_id: blog, me: 1, users: blogs[blog] });
      if (rest === '/users' && method === 'POST') {
        const b = JSON.parse(String(init!.body)) as { username: string; email: string; role: string };
        if (!/^[a-z0-9]{4,60}$/.test(b.username)) return jsonResponse({ code: 'nb_mcp_invalid_network_username', message: 'x' }, { status: 400 });
        const user = { id: 20, username: b.username, name: b.username, email: b.email, roles: [b.role], registered_date: '2026-09-28T00:00:00Z' };
        blogs[blog]!.push(user);
        return jsonResponse(user, { status: 201 });
      }
      const rm = /^\/users\/(\d+)\/remove$/.exec(rest);
      if (rm && method === 'POST') {
        const id = Number(rm[1]);
        if (id === 1) return jsonResponse({ code: 'nb_mcp_cannot_remove_self', message: 'x' }, { status: 409 });
        const user = blogs[blog]!.find((x) => x.id === id);
        if (!user) return jsonResponse({ code: 'rest_user_invalid_id', message: 'x' }, { status: 404 });
        blogs[blog] = blogs[blog]!.filter((x) => x.id !== id);
        return jsonResponse({ removed: true, user });
      }
    }
    return jsonResponse({ code: 'rest_no_route', message: 'no route' }, { status: 404 });
  });
  return { fetch, calls, bodies, blogs };
}

describe('multisite, subsite users and Site Health', () => {
  let app: TestApp;
  let wp: ReturnType<typeof fakeNetwork>;

  const start = async (opts: Parameters<typeof fakeNetwork>[0] = {}) => {
    wp = fakeNetwork(opts);
    app = await startApp(wp.fetch);
    app.store.upsert({ id: 'klant-a', name: 'Klant A', url: 'https://klant-a.nl', username: 'mcpbot' }, 'pw');
    // n8n's hourly fleet_health, with the bridge status telling it is a multisite.
    app.db.insertSnapshot('klant-a', 'fleet_health', JSON.stringify({ site: 'klant-a', ok: true, data: { ok: true, roles: ['administrator'], bridge: 'ok', versions: { wp_version: '6.8.3', multisite: opts.multisite ?? true } } }), new Date().toISOString());
  };
  afterEach(async () => {
    await app.close();
  });

  it('shows a Multisite link in the sidebar and header only for multisites', async () => {
    await start();
    const browser = await loginAndEnroll(app.base);
    const detail = await (await browser.get('/sites/klant-a')).text();
    expect(detail).toContain('href="/sites/klant-a/network"');
    expect(detail).toContain('<small>Type</small><b>multisite</b>');
    expect(await (await browser.get('/')).text()).toContain('<span class="tag">multisite</span>');
    await app.close();

    await start({ multisite: false });
    const single = await (await (await loginAndEnroll(app.base)).get('/sites/klant-a')).text();
    expect(single).not.toContain('/sites/klant-a/network');
  });

  it('lists the network sites (escaped) and opens a subsite with its details', async () => {
    await start();
    const browser = await loginAndEnroll(app.base);
    const list = await (await browser.get('/sites/klant-a/network')).text();
    expect(list).toContain('Winkel &lt;NL&gt;');
    expect(list).toContain('href="/sites/klant-a/network/2"');
    expect(list).toContain('gearchiveerd');
    expect(list).toContain('hoofdsite');

    const sub = await (await browser.get('/sites/klant-a/network/2')).text();
    expect(sub).toContain('WooCommerce');
    expect(sub).toContain('netwerkbreed');
    expect(sub).toContain('href="/sites/klant-a/network/2/users"');
    expect(sub).toContain('winkel@x.nl');

    const missing = await (await browser.get('/sites/klant-a/network/99')).text();
    expect(missing).toContain('Deze subsite bestaat niet (meer) in het netwerk.');
    const bad = await browser.get('/sites/klant-a/network/abc');
    expect(bad.headers.get('location')).toBe('/sites/klant-a/network');
  });

  it('manages the users of a subsite through the bridge, never echoing the password', async () => {
    await start();
    const browser = await loginAndEnroll(app.base);
    const page = await (await browser.get('/sites/klant-a/network/2/users')).text();
    expect(page).toContain('Gebruikers: Winkel &lt;NL&gt;');
    expect(page).toContain('Jan &lt;b&gt;de Vries&lt;/b&gt;');
    expect(page).toContain('superbeheerder');
    expect(page).toContain('Van site verwijderen');
    expect(page).toContain('pattern="[a-z0-9]{4,60}"');
    expect(page).toContain('Winkelmanager');
    const csrf = csrfOf(page);

    const invalid = await browser.post('/sites/klant-a/network/2/users', {
      _csrf: csrf, new_user_login: 'Marie-X', new_user_email: 'm@x.nl', new_user_role: 'editor', new_user_first: '', new_user_last: '', new_user_pass: SECRET,
    });
    expect(invalid.status).toBe(422);
    const invalidHtml = await invalid.text();
    expect(invalidHtml).toContain('alleen kleine letters');
    expect(invalidHtml).not.toContain(SECRET);

    const created = await browser.post('/sites/klant-a/network/2/users', {
      _csrf: csrf, new_user_login: 'mariejansen', new_user_email: 'm@x.nl', new_user_role: 'shop_manager', new_user_first: 'Marie', new_user_last: '', new_user_pass: SECRET,
    });
    expect(created.headers.get('location')).toBe('/sites/klant-a/network/2/users?created=mariejansen');
    expect(wp.blogs[2]!.map((u) => u.username)).toContain('mariejansen');
    expect(wp.bodies.some((b) => b.includes(SECRET))).toBe(true);
    expect(JSON.stringify(app.db.recentAudit())).not.toContain(SECRET);
    expect(app.db.recentAudit().find((a) => a.action === 'wp_user_created')!.target).toBe('klant-a/blog-2');

    const self = await browser.post('/sites/klant-a/network/2/users/1/delete', { _csrf: csrf, reassign: '7', confirm: 'on' });
    expect(self.status).toBe(422);
    expect(await self.text()).toContain('waarmee het dashboard inlogt');

    const removed = await browser.post('/sites/klant-a/network/2/users/7/delete', { _csrf: csrf, reassign: '1', confirm: 'on' });
    expect(removed.headers.get('location')).toBe('/sites/klant-a/network/2/users?deleted=janvries');
    expect(wp.calls).toContain('POST /wp-json/nb-mcp/v1/network/sites/2/users/7/remove');
    expect(app.db.recentAudit().map((a) => a.action)).toContain('wp_user_removed_from_site');
    expect(wp.calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
  });

  it('manages the main site of a multisite through the bridge too (REST cannot delete there)', async () => {
    await start();
    const browser = await loginAndEnroll(app.base);
    const page = await (await browser.get('/sites/klant-a/users')).text();
    expect(page).toContain('hoofdredactie');
    expect(page).toContain('action="/sites/klant-a/users/5/delete"');
    const res = await browser.post('/sites/klant-a/users/5/delete', { _csrf: csrfOf(page), reassign: '1', confirm: 'on' });
    expect(res.headers.get('location')).toBe('/sites/klant-a/users?deleted=hoofdredactie');
    expect(wp.calls).toContain('POST /wp-json/nb-mcp/v1/network/sites/1/users/5/remove');
  });

  it('refreshes Site Health live, shows tests grouped and escaped, and only safe links', async () => {
    await start();
    const browser = await loginAndEnroll(app.base);
    const before = await (await browser.get('/sites/klant-a')).text();
    expect(before).toContain('Nog geen Site Health-gegevens');
    const res = await browser.post('/sites/klant-a/health/refresh', { _csrf: csrfOf(before) });
    expect(res.headers.get('location')).toBe('/sites/klant-a?health=1#health');
    expect(wp.calls.some((c) => c.includes('/site-health'))).toBe(true);

    const page = await (await browser.get('/sites/klant-a?health=1')).text();
    expect(page).toContain('Site Health opnieuw gecontroleerd.');
    expect(page).toContain('Je site draait op een &lt;verouderde&gt; PHP-versie');
    expect(page).toContain('<p>PHP 7.4 wordt niet meer ondersteund.</p><p>Werk PHP bij.</p>');
    expect(page).toContain('href="https://wordpress.org/support/update-php/"');
    expect(page).not.toContain('href="javascript:');
    expect(page).toContain('1 kritiek');
    expect(page).toContain('1,2 GB');
    expect(page).toContain('href="/sites/klant-a#health"');
    expect(app.db.recentAudit().map((a) => a.action)).toContain('site_health_checked');

    const overview = await (await browser.get('/')).text();
    expect(overview).toContain('1 kritiek');
  });

  it('explains an old bridge instead of failing, for Site Health and Multisite', async () => {
    await start({ features: ['safe_updates'] });
    const browser = await loginAndEnroll(app.base);
    const csrf = csrfOf(await (await browser.get('/sites/klant-a')).text());
    await browser.post('/sites/klant-a/health/refresh', { _csrf: csrf });
    expect(await (await browser.get('/sites/klant-a')).text()).toContain('te oud hiervoor. Werk hem bij naar 1.2.0');
    expect(wp.calls.some((c) => c.includes('/site-health'))).toBe(false);
    expect(await (await browser.get('/sites/klant-a/network')).text()).toContain('Werk hem bij naar 1.2.0');
  });

  it('stores n8n fleet_site_health per site', async () => {
    await start();
    const res = await fetch(`${app.base}/api/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'i'.repeat(40)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'fleet_site_health', data: { summary: {}, results: [{ site: 'klant-a', ok: true, data: HEALTH }] } }),
    });
    expect(res.status).toBe(200);
    expect(latestHealth(app.db.latestSnapshots('klant-a'))?.data?.summary).toEqual(HEALTH.summary);
  });
});
