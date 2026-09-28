import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUpdateSelection, runUpdates } from '../../src/dashboard/updates.js';
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
function fakeBridge(initial: Pending) {
  const state: Pending = structuredClone(initial);
  const calls: string[] = [];
  const fetch = createMockFetch(async (url, init) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (pathname.endsWith('/nb-mcp/v1/updates') && method === 'GET') {
      return jsonResponse({ checked_at: 'now', ...state, translations: { count: state.translations } });
    }
    if (pathname.endsWith('/updates/plugins')) {
      const results = (body.plugins as string[]).map((file) => {
        const p = state.plugins.find((x) => x.plugin === file)!;
        if (file === 'broken/broken.php') return { plugin: file, success: false, from: p.current_version, to: p.new_version, error: 'Download failed.' };
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
  return { fetch, state, calls };
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
      core: true, allowMajor: false, plugins: ['a/a.php'], themes: ['x'], translations: false,
    });
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
