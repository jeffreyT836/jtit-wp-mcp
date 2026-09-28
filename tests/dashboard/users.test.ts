import { afterEach, describe, expect, it } from 'vitest';
import { parseNewUser, userErrorMessage } from '../../src/dashboard/users.js';
import { WpError } from '../../src/wp/errors.js';
import { createMockFetch, jsonResponse } from '../helpers/harness.js';
import { csrfOf, loginAndEnroll, startApp, type TestApp } from './helpers.js';

const SECRET = 'Zeer-Geheim-Wachtwoord-42!';

interface FakeUser { id: number; username: string; name: string; email: string; roles: string[]; registered_date: string }

/** Stateful fake of the WordPress users REST API plus the bridge's /roles route. */
function fakeWordPress(opts: { bridge?: boolean } = {}) {
  let nextId = 4;
  const users: FakeUser[] = [
    { id: 1, username: 'mcp-bot', name: 'MCP bot', email: 'bot@x.nl', roles: ['administrator'], registered_date: '2026-01-01T00:00:00' },
    { id: 2, username: 'jan', name: 'Jan <b>de Vries</b>', email: 'jan@x.nl', roles: ['editor'], registered_date: '2026-02-01T00:00:00' },
    { id: 3, username: 'piet', name: 'Piet', email: 'piet@x.nl', roles: ['shop_manager'], registered_date: '2026-03-01T00:00:00' },
  ];
  const calls: string[] = [];
  const bodies: string[] = [];
  const fetch = createMockFetch(async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${u.pathname}${method === 'DELETE' ? u.search : ''}`);
    if (init?.body) bodies.push(String(init.body));
    if (u.pathname.endsWith('/nb-mcp/v1/roles')) {
      if (opts.bridge === false) return jsonResponse({ code: 'rest_no_route', message: 'no route' }, { status: 404 });
      return jsonResponse({ roles: [
        { slug: 'administrator', name: 'Beheerder' }, { slug: 'editor', name: 'Redacteur' },
        { slug: 'subscriber', name: 'Abonnee' }, { slug: 'shop_manager', name: 'Winkelmanager' },
      ] });
    }
    if (u.pathname.endsWith('/wp/v2/users/me')) return jsonResponse(users[0]);
    const one = /\/wp\/v2\/users\/(\d+)$/.exec(u.pathname);
    if (one) {
      const user = users.find((x) => x.id === Number(one[1]));
      if (!user) return jsonResponse({ code: 'rest_user_invalid_id', message: 'Invalid user ID.' }, { status: 404 });
      if (method === 'DELETE') {
        users.splice(users.indexOf(user), 1);
        return jsonResponse({ deleted: true, previous: user });
      }
      return jsonResponse(user);
    }
    if (u.pathname.endsWith('/wp/v2/users')) {
      if (method === 'POST') {
        const body = JSON.parse(String(init!.body)) as { username: string; email: string; roles: string[]; first_name?: string };
        if (users.some((x) => x.username === body.username)) {
          return jsonResponse({ code: 'existing_user_login', message: 'Sorry, that username already exists!' }, { status: 500 });
        }
        const created = { id: nextId++, username: body.username, name: body.first_name ?? body.username, email: body.email, roles: body.roles, registered_date: '2026-09-28T00:00:00' };
        users.push(created);
        return jsonResponse(created, { status: 201 });
      }
      return jsonResponse(users, { headers: { 'x-wp-totalpages': '1' } });
    }
    return jsonResponse({ code: 'rest_no_route', message: 'no route' }, { status: 404 });
  });
  return { fetch, users, calls, bodies };
}

const validForm = {
  new_user_login: 'marie',
  new_user_email: 'marie@x.nl',
  new_user_role: 'editor',
  new_user_first: 'Marie',
  new_user_last: '',
  new_user_pass: SECRET,
};

describe('parseNewUser', () => {
  it('accepts a valid form and drops empty optional names', () => {
    const r = parseNewUser(validForm);
    expect(r).toEqual({ ok: true, user: { username: 'marie', email: 'marie@x.nl', role: 'editor', password: SECRET, first_name: 'Marie', last_name: undefined } });
  });

  it.each([
    [{ new_user_pass: 'kort' }, /minstens 12/],
    [{ new_user_pass: 'met\\backslash-lang-genoeg' }, /\\/],
    [{ new_user_pass: ' spatie-aan-het-begin' }, /spatie/],
    [{ new_user_pass: 'xx-MARIE-lang-genoeg' }, /gebruikersnaam niet/],
    [{ new_user_login: 'met spatie' }, /Gebruikersnaam/],
    [{ new_user_email: 'geen-email' }, /E-mailadres/],
    [{ new_user_role: 'Admin<script>' }, /Rol/],
  ])('rejects %j', (override, message) => {
    const r = parseNewUser({ ...validForm, ...override });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(message);
  });

  it('never puts the password in an error message', () => {
    const r = parseNewUser({ ...validForm, new_user_login: 'a b', new_user_pass: 'secret-with\\slash' });
    expect(!r.ok && r.error).not.toContain('secret-with');
  });

  it('maps WordPress error codes to Dutch messages', () => {
    const err = new WpError({ status: 500, code: 'existing_user_email', message: 'x', site: 's' });
    expect(userErrorMessage(err)).toBe('Er bestaat al een gebruiker met dit e-mailadres.');
    expect(userErrorMessage(new Error('refusing to delete the account the MCP server itself authenticates as'))).toMatch(/dashboard inlogt/);
  });
});

describe('dashboard user management', () => {
  let app: TestApp;
  let wp: ReturnType<typeof fakeWordPress>;

  const start = async (opts: { bridge?: boolean; readOnly?: boolean } = {}) => {
    wp = fakeWordPress(opts);
    app = await startApp(wp.fetch);
    app.store.upsert({ id: 'klant-a', name: 'Klant A', url: 'https://klant-a.nl', username: 'mcp-bot', bridge: opts.bridge ?? true, readOnly: opts.readOnly ?? false }, 'pw');
  };

  afterEach(async () => {
    await app.close();
  });

  it('lists users live with role names, marks the bot account and escapes names', async () => {
    await start();
    const browser = await loginAndEnroll(app.base);
    expect(await (await browser.get('/sites/klant-a')).text()).toContain('href="/sites/klant-a/users"');
    const page = await (await browser.get('/sites/klant-a/users')).text();
    expect(page).toContain('Gebruikers: Klant A');
    expect(page).toContain('koppeling dashboard');
    expect(page).toContain('Winkelmanager');
    expect(page).toContain('Jan &lt;b&gt;de Vries&lt;/b&gt;');
    expect(page).not.toContain('action="/sites/klant-a/users/1/delete"');
    expect(page).toContain('action="/sites/klant-a/users/2/delete"');
    expect(page).toContain('name="new_user_pass"');
    expect(page).toMatch(/name="new_user_pass"[^>]*autocomplete="new-password"/);
    expect(page).not.toMatch(/name="(username|password)"/);
  });

  it('falls back to the default roles when the bridge is missing', async () => {
    await start({ bridge: false });
    const browser = await loginAndEnroll(app.base);
    const page = await (await browser.get('/sites/klant-a/users')).text();
    expect(page).toContain('<option value="subscriber" selected>Abonnee</option>');
    expect(page).not.toContain('Winkelmanager');
  });

  it('creates a user and never stores, logs or echoes the password', async () => {
    await start();
    const browser = await loginAndEnroll(app.base);
    const csrf = csrfOf(await (await browser.get('/sites/klant-a/users')).text());
    const res = await browser.post('/sites/klant-a/users', { _csrf: csrf, ...validForm });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sites/klant-a/users?created=marie');
    expect(wp.users.find((u) => u.username === 'marie')).toMatchObject({ email: 'marie@x.nl', roles: ['editor'] });
    expect(wp.bodies.some((b) => b.includes(SECRET))).toBe(true);
    const audit = app.db.recentAudit().find((a) => a.action === 'wp_user_created')!;
    expect(JSON.parse(audit.details!)).toMatchObject({ username: 'marie', role: 'editor' });
    expect(JSON.stringify(app.db.recentAudit())).not.toContain(SECRET);
    expect(await (await browser.get('/sites/klant-a/users?created=marie')).text()).toContain('Gebruiker &quot;marie&quot; is aangemaakt');
    expect(await (await browser.get('/sites/klant-a/users?created=Bel%20ons%20op%20060')).text()).not.toContain('Bel ons op');
  });

  it('re-renders validation and WordPress errors without the password', async () => {
    await start();
    const browser = await loginAndEnroll(app.base);
    const csrf = csrfOf(await (await browser.get('/sites/klant-a/users')).text());
    const weak = await browser.post('/sites/klant-a/users', { _csrf: csrf, ...validForm, new_user_pass: 'kort' });
    expect(weak.status).toBe(422);
    expect(await weak.text()).toContain('minstens 12 tekens');
    expect(wp.calls.filter((c) => c.startsWith('POST'))).toEqual([]);

    const dup = await browser.post('/sites/klant-a/users', { _csrf: csrf, ...validForm, new_user_login: 'jan' });
    expect(dup.status).toBe(422);
    const body = await dup.text();
    expect(body).toContain('Er bestaat al een gebruiker met deze gebruikersnaam.');
    expect(body).toContain('value="marie@x.nl"');
    expect(body).not.toContain(SECRET);
    expect(app.db.recentAudit().map((a) => a.action)).toContain('wp_user_create_failed');
  });

  it('deletes a user with confirmation and reassigns their content', async () => {
    await start();
    const browser = await loginAndEnroll(app.base);
    const csrf = csrfOf(await (await browser.get('/sites/klant-a/users')).text());
    const unconfirmed = await browser.post('/sites/klant-a/users/2/delete', { _csrf: csrf, reassign: '1' });
    expect(unconfirmed.status).toBe(422);
    expect(wp.users).toHaveLength(3);

    const res = await browser.post('/sites/klant-a/users/2/delete', { _csrf: csrf, reassign: '1', confirm: 'on' });
    expect(res.headers.get('location')).toBe('/sites/klant-a/users?deleted=jan');
    expect(wp.calls).toContain('DELETE /wp-json/wp/v2/users/2?force=true&reassign=1');
    expect(wp.users.map((u) => u.username)).toEqual(['mcp-bot', 'piet']);
    expect(app.db.recentAudit().map((a) => a.action)).toContain('wp_user_deleted');
  });

  it('refuses to delete the bot account, self-reassign and invalid ids', async () => {
    await start();
    const browser = await loginAndEnroll(app.base);
    const csrf = csrfOf(await (await browser.get('/sites/klant-a/users')).text());
    const self = await browser.post('/sites/klant-a/users/1/delete', { _csrf: csrf, reassign: '2', confirm: 'on' });
    expect(self.status).toBe(422);
    expect(await self.text()).toContain('waarmee het dashboard inlogt');
    const same = await browser.post('/sites/klant-a/users/2/delete', { _csrf: csrf, reassign: '2', confirm: 'on' });
    expect(same.status).toBe(422);
    const bad = await browser.post('/sites/klant-a/users/abc/delete', { _csrf: csrf, reassign: '1', confirm: 'on' });
    expect(bad.status).toBe(422);
    expect(wp.calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
  });

  it('blocks writes on read-only sites and requires CSRF', async () => {
    await start({ readOnly: true });
    const browser = await loginAndEnroll(app.base);
    const page = await (await browser.get('/sites/klant-a/users')).text();
    expect(page).toContain('aanmaken en verwijderen is uitgeschakeld');
    expect(page).not.toContain('name="new_user_pass"');
    const csrf = csrfOf(page);
    expect((await browser.post('/sites/klant-a/users', { _csrf: csrf, ...validForm })).status).toBe(403);
    expect((await browser.post('/sites/klant-a/users/2/delete', { _csrf: csrf, reassign: '1', confirm: 'on' })).status).toBe(403);
    expect((await browser.post('/sites/klant-a/users', { ...validForm })).status).toBe(403);
    expect(wp.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('requires login', async () => {
    await start();
    const res = await fetch(`${app.base}/sites/klant-a/users`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/\/login/);
  });
});
