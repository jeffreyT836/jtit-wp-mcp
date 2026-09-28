import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginFailureMessage } from '../../src/dashboard/routes/site-routes.js';
import { failedChecks, parseUpdateSelection, plainText, runUpdates, SafeUpdatesUnsupportedError } from '../../src/dashboard/updates.js';
import { WpClient } from '../../src/wp/client.js';
import { createMockFetch, jsonResponse, makeSite } from '../helpers/harness.js';
import { csrfOf, loginAndEnroll, startApp, type TestApp } from './helpers.js';

interface Pending {
  plugins: Array<{ plugin: string; name: string; current_version: string; new_version: string; package_available?: boolean }>;
  themes: Array<{ stylesheet: string; name: string; current_version: string; new_version: string }>;
  core: Array<{ current: string; version: string; response: string; type: 'minor' | 'major' }>;
  translations: number;
}

/** Stateful fake nb-mcp-bridge: pending updates disappear once applied. */
function fakeBridge(initial: Pending, opts: { safeSupported?: boolean } = {}) {
  const state: Pending = structuredClone(initial);
  const calls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = createMockFetch(async (url, init) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === 'POST') bodies.push(body);
    if (pathname.endsWith('/nb-mcp/v1/status')) {
      return jsonResponse({ bridge_version: opts.safeSupported === false ? '1.0.7' : '1.1.0', ...(opts.safeSupported === false ? {} : { features: ['safe_updates'] }) });
    }
    if (pathname.endsWith('/nb-mcp/v1/updates') && method === 'GET') {
      return jsonResponse({ checked_at: 'now', ...state, translations: { count: state.translations } });
    }
    if (pathname.endsWith('/updates/plugins')) {
      const results = (body.plugins as string[]).map((file) => {
        const p = state.plugins.find((x) => x.plugin === file)!;
        if (file === 'broken/broken.php') return { plugin: file, success: false, from: p.current_version, to: p.new_version, error: 'Download failed.' };
        if (body.safe && file === 'fatal/fatal.php') {
          return {
            plugin: file, success: false, from: p.current_version, to: p.current_version,
            error: 'Site unhealthy after update; restored from backup.', backup: 'created', rolled_back: true,
            health: { ok: false, checks: [{ target: 'home', ok: false, status: 500, error: 'Page shows a PHP fatal error.' }, { target: '/winkel', ok: false, status: 404, ignored: true }] },
          };
        }
        if (body.safe && file === 'stuck/stuck.php') {
          return {
            plugin: file, success: false, from: p.current_version, to: p.current_version, backup: 'created', rolled_back: true,
            rollback_error: 'Site still unhealthy after restoring the backup.', backup_path: 'wp-content/nb-mcp-backups/x/plugins/stuck',
            health: { ok: false, checks: [{ target: 'error_log', ok: false, error: '<b>PHP Fatal error</b> in x.php' }] },
          };
        }
        state.plugins = state.plugins.filter((x) => x.plugin !== file);
        return { plugin: file, success: true, from: p.current_version, to: p.new_version };
      });
      return jsonResponse({ results });
    }
    if (pathname.endsWith('/updates/themes')) {
      const results = (body.themes as string[]).map((theme) => {
        const t = state.themes.find((x) => x.stylesheet === theme)!;
        state.themes = state.themes.filter((x) => x.stylesheet !== theme);
        return { theme, success: true, from: t.current_version, to: t.new_version };
      });
      return jsonResponse({ results });
    }
    if (pathname.endsWith('/updates/core')) {
      const offer = state.core.find((c) => body.allow_major || c.type === 'minor');
      if (!offer) return jsonResponse({ success: false, from: '7.1', to: '7.1', error: 'No core update available.', no_update: true });
      state.core = [];
      return jsonResponse({ success: true, from: offer.current, to: offer.version });
    }
    if (pathname.endsWith('/updates/translations')) {
      const count = state.translations;
      state.translations = 0;
      return jsonResponse(count === 0 ? { success: true, count: 0, failed: 0, no_update: true } : { success: true, count, failed: 0 });
    }
    return jsonResponse({ code: 'rest_no_route', message: 'no route' }, { status: 404 });
  });
  return { fetch, state, calls, bodies };
}

const PENDING: Pending = {
  plugins: [
    { plugin: 'akismet/akismet.php', name: 'Akismet <Anti-spam>', current_version: '5.0', new_version: '5.3' },
    { plugin: 'broken/broken.php', name: 'Broken', current_version: '1.0', new_version: '1.1' },
    { plugin: 'premium/premium.php', name: 'Premium', current_version: '2.0', new_version: '2.1', package_available: false },
  ],
  themes: [{ stylesheet: 'astra', name: 'Astra', current_version: '4.0', new_version: '4.1' }],
  core: [
    { current: '7.1', version: '7.1.2', response: 'upgrade', type: 'minor' },
    { current: '7.1', version: '8.0', response: 'upgrade', type: 'major' },
  ],
  translations: 3,
};

describe('parseUpdateSelection', () => {
  it('normalizes single values, arrays and duplicates', () => {
    expect(parseUpdateSelection({ core: 'on', plugins: 'a/a.php', themes: ['x', 'x', ''] })).toEqual({
      core: true, allowMajor: false, plugins: ['a/a.php'], themes: ['x'], translations: false, safe: false,
    });
    expect(parseUpdateSelection({ safe: 'on' }).safe).toBe(true);
  });

  it('rejects oversized selections', () => {
    expect(() => parseUpdateSelection({ plugins: Array.from({ length: 201 }, (_, i) => `p${i}`) })).toThrow(/te veel/);
  });
});

describe('runUpdates', () => {
  it('runs core → plugins → themes → translations and reports per item', async () => {
    const bridge = fakeBridge(PENDING);
    const client = new WpClient(makeSite({ id: 'a' }), { fetch: bridge.fetch });
    const results = await runUpdates(
      client,
      { core: true, allowMajor: false, plugins: ['akismet/akismet.php', 'broken/broken.php', 'gone/gone', '../evil'], themes: ['astra'], translations: true },
      5000,
    );
    expect(results).toEqual([
      { kind: 'core', id: 'wordpress', from: '7.1', to: '7.1.2', status: 'updated' },
      { kind: 'plugin', id: '../evil', status: 'failed', message: expect.stringContaining('invalid plugin identifier') },
      { kind: 'plugin', id: 'gone/gone', status: 'up_to_date' },
      { kind: 'plugin', id: 'akismet/akismet', from: '5.0', to: '5.3', status: 'updated' },
      { kind: 'plugin', id: 'broken/broken', from: '1.0', to: '1.1', status: 'failed', message: 'Download failed.' },
      { kind: 'theme', id: 'astra', from: '4.0', to: '4.1', status: 'updated' },
      { kind: 'translations', id: 'vertalingen', status: 'updated', message: '3 vertaling(en) bijgewerkt' },
    ]);
    const posts = bridge.calls.filter((c) => c.startsWith('POST'));
    expect(posts).toEqual([
      'POST /wp-json/nb-mcp/v1/updates/core',
      'POST /wp-json/nb-mcp/v1/updates/plugins',
      'POST /wp-json/nb-mcp/v1/updates/themes',
      'POST /wp-json/nb-mcp/v1/updates/translations',
    ]);
  });

  it('skips a major-only core update unless allowMajor is set', async () => {
    const onlyMajor = { ...PENDING, core: [PENDING.core[1]!] };
    const client = new WpClient(makeSite({ id: 'a' }), { fetch: fakeBridge(onlyMajor).fetch });
    const [skipped] = await runUpdates(client, { core: true, allowMajor: false, plugins: [], themes: [], translations: false }, 5000);
    expect(skipped).toMatchObject({ status: 'skipped', to: '8.0' });
    const [done] = await runUpdates(client, { core: true, allowMajor: true, plugins: [], themes: [], translations: false }, 5000);
    expect(done).toMatchObject({ status: 'updated', from: '7.1', to: '8.0' });
  });

  it('turns bridge errors into failed items instead of throwing', async () => {
    const client = new WpClient(makeSite({ id: 'a' }), {
      fetch: createMockFetch(() => jsonResponse({ code: 'nb_mcp_forbidden', message: 'nope' }, { status: 403 })),
    });
    const results = await runUpdates(client, { core: true, allowMajor: false, plugins: ['a/a'], themes: ['t'], translations: true }, 5000);
    expect(results.map((r) => r.status)).toEqual(['failed', 'failed', 'failed', 'failed']);
  });
});

describe('safe updates', () => {
  const SAFE_PENDING: Pending = {
    ...PENDING,
    plugins: [
      ...PENDING.plugins,
      { plugin: 'fatal/fatal.php', name: 'Fatal', current_version: '1.0', new_version: '2.0' },
      { plugin: 'stuck/stuck.php', name: 'Stuck', current_version: '1.0', new_version: '2.0' },
    ],
  };
  const sel = (plugins: string[]) => ({ core: false, allowMajor: false, plugins, themes: [], translations: false, safe: true });

  it('refuses when the bridge does not support safe updates, before changing anything', async () => {
    const bridge = fakeBridge(SAFE_PENDING, { safeSupported: false });
    const client = new WpClient(makeSite({ id: 'a' }), { fetch: bridge.fetch });
    await expect(runUpdates(client, sel(['akismet/akismet.php']), 5000)).rejects.toBeInstanceOf(SafeUpdatesUnsupportedError);
    expect(bridge.bodies).toEqual([]);
  });

  it('sends one request per item with safe + health paths and maps rollbacks', async () => {
    const bridge = fakeBridge(SAFE_PENDING);
    const client = new WpClient(makeSite({ id: 'a' }), { fetch: bridge.fetch });
    const results = await runUpdates(client, sel(['akismet/akismet.php', 'fatal/fatal.php', 'stuck/stuck.php']), 5000, ['/winkel']);
    expect(bridge.bodies).toEqual([
      { plugins: ['akismet/akismet.php'], safe: true, health_paths: ['/winkel'] },
      { plugins: ['fatal/fatal.php'], safe: true, health_paths: ['/winkel'] },
      { plugins: ['stuck/stuck.php'], safe: true, health_paths: ['/winkel'] },
    ]);
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ['akismet/akismet', 'updated'],
      ['fatal/fatal', 'rolled_back'],
      ['stuck/stuck', 'rollback_failed'],
    ]);
    expect(results[1]!.message).toBe('Fouten na de update, automatisch teruggezet (homepage: Page shows a PHP fatal error.).');
    expect(results[2]!.message).toContain('errorlog: PHP Fatal error in x.php');
    expect(results[2]!.message).toContain('wp-content/nb-mcp-backups/x/plugins/stuck');
  });

  it('explains WordPress login failures by error code', () => {
    expect(loginFailureMessage('mcp-bot', 'invalid_username', '<strong>Fout:</strong> onbekende gebruikersnaam.')).toContain('geen gebruiker met inlognaam of e-mailadres "mcp-bot"');
    expect(loginFailureMessage('mcp-bot', 'incorrect_password')).toContain('Application Password klopt niet');
    expect(loginFailureMessage('mcp-bot', undefined, '<strong>Fout:</strong> iets')).toBe('Inloggen mislukt: Fout: iets');
  });

  it('strips markup from WordPress messages and summarizes failed checks', () => {
    expect(plainText('<strong>Fout:</strong> onbekende   gebruikersnaam.')).toBe('Fout: onbekende gebruikersnaam.');
    expect(failedChecks([{ target: 'login', ok: false, status: 502 }, { target: '/x', ok: false, ignored: true }, { target: 'home', ok: true }])).toBe('inlogpagina: HTTP 502');
  });
});

describe('dashboard update flow', () => {
  let app: TestApp;
  let bridge: ReturnType<typeof fakeBridge>;

  beforeEach(async () => {
    bridge = fakeBridge(PENDING);
    app = await startApp(bridge.fetch);
    app.store.upsert({ id: 'klant-a', name: 'Klant A', url: 'https://klant-a.nl', username: 'mcp-bot' }, 'pw');
  });

  afterEach(async () => {
    await app.close();
  });

  it('shows a hint without data, refreshes live and lists the pending updates', async () => {
    const browser = await loginAndEnroll(app.base);
    const empty = await (await browser.get('/sites/klant-a')).text();
    expect(empty).toContain('Nog geen update-gegevens');

    const refreshed = await browser.post('/sites/klant-a/updates/refresh', { _csrf: csrfOf(empty) });
    expect(refreshed.headers.get('location')).toBe('/sites/klant-a?refreshed=1#updates');
    const page = await (await browser.get('/sites/klant-a?refreshed=1')).text();
    expect(page).toContain('Akismet &lt;Anti-spam&gt;');
    expect(page).toContain('value="akismet/akismet.php"');
    expect(page).toMatch(/value="premium\/premium.php"[^>]*disabled/);
    expect(page).toContain('Major-versie toestaan');
    expect(page).toContain('3 vertaling(en) bijwerken');
    expect(page).toContain('src="/assets/app.js"');
    expect(page).toMatch(/name="safe" checked/);
    expect(app.db.recentAudit().map((a) => a.action)).toContain('updates_checked');
  });

  it('requires confirmation and a selection, and refuses major without core', async () => {
    const browser = await loginAndEnroll(app.base);
    const csrf = csrfOf(await (await browser.get('/sites/klant-a')).text());
    expect(await (await browser.post('/sites/klant-a/updates', { _csrf: csrf, core: 'on' })).text()).toContain('Bevestig eerst');
    expect(await (await browser.post('/sites/klant-a/updates', { _csrf: csrf, confirm: 'on' })).text()).toContain('Selecteer minstens');
    expect(await (await browser.post('/sites/klant-a/updates', { _csrf: csrf, confirm: 'on', allow_major: 'on' })).text()).toContain('werkt alleen samen');
    expect((await browser.post('/sites/klant-a/updates', { core: 'on', confirm: 'on' })).status).toBe(403);
    expect(bridge.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('runs the selected updates, shows per-item results and audits them', async () => {
    const browser = await loginAndEnroll(app.base);
    const csrf = csrfOf(await (await browser.post('/sites/klant-a/updates/refresh', { _csrf: csrfOf(await (await browser.get('/sites/klant-a')).text()) }).then(() => browser.get('/sites/klant-a'))).text());
    const res = await browser.post('/sites/klant-a/updates', {
      _csrf: csrf, confirm: 'on', core: 'on', plugins: ['akismet/akismet.php', 'broken/broken.php'], themes: 'astra',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('1 van 4 onderdelen zijn mislukt.');
    expect(html).toContain('Akismet &lt;Anti-spam&gt;');
    expect(html).toContain('Download failed.');

    const audit = app.db.recentAudit().find((a) => a.action === 'updates_run')!;
    expect(JSON.parse(audit.details!)).toMatchObject({ updated: 3, failed: 1 });
    // The post-run live check is stored, so the page now shows what is still pending.
    const after = await (await browser.get('/sites/klant-a')).text();
    expect(after).not.toContain('value="akismet/akismet.php"');
    expect(after).toContain('value="broken/broken.php"');
  });

  it('allows only one update run per site at a time', async () => {
    await app.close();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = createMockFetch(async (url, init) => {
      if (new URL(url).pathname.endsWith('/updates/core')) await gate;
      return bridge.fetch(url, init);
    });
    app = await startApp(slow);
    app.store.upsert({ id: 'klant-a', name: 'Klant A', url: 'https://klant-a.nl', username: 'mcp-bot' }, 'pw');
    const browser = await loginAndEnroll(app.base);
    const csrf = csrfOf(await (await browser.get('/sites/klant-a')).text());
    const first = browser.post('/sites/klant-a/updates', { _csrf: csrf, confirm: 'on', core: 'on' });
    await new Promise((r) => setTimeout(r, 50));
    const second = await browser.post('/sites/klant-a/updates', { _csrf: csrf, confirm: 'on', core: 'on' });
    expect(second.status).toBe(409);
    expect(await second.text()).toContain('Er loopt al een update');
    release();
    expect((await first).status).toBe(200);
  });

  it('shows rollbacks on the result page and refuses safe mode on an old bridge', async () => {
    const browser = await loginAndEnroll(app.base);
    const csrf = csrfOf(await (await browser.get('/sites/klant-a')).text());
    const res = await browser.post('/sites/klant-a/updates', { _csrf: csrf, confirm: 'on', safe: 'on', plugins: ['akismet/akismet.php'] });
    expect(await res.text()).toContain('Alle 1 onderdelen zijn verwerkt.');
    expect(JSON.parse(app.db.recentAudit().find((a) => a.action === 'updates_run')!.details!)).toMatchObject({ safe: true, rolledBack: 0 });

    await app.close();
    bridge = fakeBridge(PENDING, { safeSupported: false });
    app = await startApp(bridge.fetch);
    app.store.upsert({ id: 'klant-a', name: 'Klant A', url: 'https://klant-a.nl', username: 'mcp-bot' }, 'pw');
    const b2 = await loginAndEnroll(app.base);
    const csrf2 = csrfOf(await (await b2.get('/sites/klant-a')).text());
    const old = await b2.post('/sites/klant-a/updates', { _csrf: csrf2, confirm: 'on', safe: 'on', core: 'on' });
    expect(old.status).toBe(409);
    expect(await old.text()).toContain('ondersteunt nog geen veilig updaten');
    expect(bridge.bodies).toEqual([]);
  });

  it('saves extra health paths from the site form and rejects invalid ones', async () => {
    const browser = await loginAndEnroll(app.base);
    const edit = await (await browser.get('/sites/klant-a/edit')).text();
    const fields = { _csrf: csrfOf(edit), name: 'Klant A', url: 'https://klant-a.nl', wp_user: 'mcp-bot', bridge: 'on', skipTest: 'on' };
    const bad = await browser.post('/sites/klant-a', { ...fields, healthPaths: 'https://evil.example' });
    expect(bad.status).toBe(422);
    await browser.post('/sites/klant-a', { ...fields, healthPaths: '/winkel\r\n\r\n/contact' });
    expect(app.store.list()[0]!.healthPaths).toEqual(['/winkel', '/contact']);
    expect(await (await browser.get('/sites/klant-a/edit')).text()).toContain('/winkel\n/contact</textarea>');
  });

  it('refuses updates on read-only sites', async () => {
    app.store.upsert({ id: 'klant-a', name: 'Klant A', url: 'https://klant-a.nl', username: 'mcp-bot', readOnly: true });
    const browser = await loginAndEnroll(app.base);
    const csrf = csrfOf(await (await browser.get('/sites/klant-a')).text());
    await browser.post('/sites/klant-a/updates/refresh', { _csrf: csrf });
    expect(await (await browser.get('/sites/klant-a')).text()).toContain('updates uitvoeren is uitgeschakeld');
    const res = await browser.post('/sites/klant-a/updates', { _csrf: csrf, confirm: 'on', core: 'on' });
    expect(res.status).toBe(403);
    expect(bridge.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
  });
});
