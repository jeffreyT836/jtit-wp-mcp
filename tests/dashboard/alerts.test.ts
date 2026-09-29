import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acknowledgeAlert, evaluateSites, evaluateStaleData } from '../../src/dashboard/alerts.js';
import { DashboardDb } from '../../src/dashboard/db.js';
import { AlertNotifier } from '../../src/dashboard/notify.js';
import type { StoredSite } from '../../src/store/site-store.js';
import { WPVULNERABILITY_API } from '../../src/wp/vulnerabilities.js';
import { createMockFetch, jsonResponse } from '../helpers/harness.js';
import { csrfOf, loginAndEnroll, startApp, type TestApp } from './helpers.js';

const SITE = { id: 'klant-a', name: 'Klant A', bridge: true } as StoredSite;
const HOUR = 3_600_000;
let t = Date.parse('2026-09-29T08:00:00Z');

function snap(db: DashboardDb, kind: string, data: unknown, siteId = SITE.id) {
  t += HOUR;
  db.insertSnapshot(siteId, kind, JSON.stringify(data), new Date(t).toISOString());
  return evaluateSites(db, [SITE], kind, [siteId]);
}

const healthy = { site: SITE.id, ok: true, data: { ok: true, roles: ['administrator'], bridge: 'ok' } };
const down = { site: SITE.id, ok: true, data: { ok: false, roles: [], bridge: 'error', error: 'cURL error 28: <b>timeout</b>' } };
const summary = (changes: ReturnType<typeof evaluateSites>) => changes.map((c) => `${c.change}:${c.alert.type}`);

describe('alert rules', () => {
  let db: DashboardDb;
  beforeEach(() => {
    db = new DashboardDb(':memory:');
  });
  afterEach(() => db.close());

  it('opens "unreachable" only after two failed checks and resolves it on recovery', () => {
    expect(snap(db, 'fleet_health', healthy)).toEqual([]);
    expect(snap(db, 'fleet_health', down)).toEqual([]);
    expect(db.activeAlerts()[0]!.status).toBe('pending');
    const opened = snap(db, 'fleet_health', down);
    expect(summary(opened)).toEqual(['opened:unreachable']);
    expect(JSON.parse(opened[0]!.alert.details!)).toEqual({ error: 'cURL error 28: timeout' });
    // Still down: no new notification.
    expect(snap(db, 'fleet_health', down)).toEqual([]);
    expect(summary(snap(db, 'fleet_health', healthy))).toEqual(['resolved:unreachable']);
    expect(db.activeAlerts()).toEqual([]);
  });

  it('drops a single failed check silently', () => {
    snap(db, 'fleet_health', down);
    expect(snap(db, 'fleet_health', healthy)).toEqual([]);
    expect(db.listAlerts().resolved).toEqual([]);
  });

  it('keeps admin/bridge alerts while the site is unreachable', () => {
    const noBridge = { ...healthy, data: { ...healthy.data, roles: ['editor'], bridge: 'missing' } };
    expect(summary(snap(db, 'fleet_health', noBridge))).toEqual(['opened:not_admin', 'opened:bridge_problem']);
    snap(db, 'fleet_health', down);
    snap(db, 'fleet_health', down);
    expect(db.activeAlerts().map((a) => a.type).sort()).toEqual(['bridge_problem', 'not_admin', 'unreachable']);
    expect(summary(snap(db, 'fleet_health', healthy)).sort()).toEqual(['resolved:bridge_problem', 'resolved:not_admin', 'resolved:unreachable']);
  });

  it('alerts on a new administrator after the baseline, until acknowledged', () => {
    const audit = (users: string[]) => ({ site: SITE.id, ok: true, users: users.map((u, i) => ({ id: i + 1, username: u, email: `${u}@x.nl`, roles: ['administrator'] })) });
    expect(snap(db, 'fleet_user_audit', audit(['mcp-bot', 'jeffrey']))).toEqual([]);
    const opened = snap(db, 'fleet_user_audit', audit(['mcp-bot', 'jeffrey', 'wp-support1']));
    expect(summary(opened)).toEqual(['opened:new_admin']);
    expect(opened[0]!.alert.title).toBe('Nieuw administrator-account: wp-support1');
    // The next audit no longer sees it as new, but an event alert stays open.
    expect(snap(db, 'fleet_user_audit', audit(['mcp-bot', 'jeffrey', 'wp-support1']))).toEqual([]);
    expect(db.activeAlerts()).toHaveLength(1);
    const acked = acknowledgeAlert(db, opened[0]!.alert.id, 'admin@jtit.nl');
    expect(acked).toMatchObject({ status: 'resolved', acknowledged_by: 'admin@jtit.nl' });
    // A failed audit is not a baseline: no alert storm afterwards.
    snap(db, 'fleet_user_audit', { site: SITE.id, ok: false, error: 'boom', users: [] });
    expect(snap(db, 'fleet_user_audit', audit(['mcp-bot', 'jeffrey', 'wp-support1']))).toEqual([]);
  });

  it('groups vulnerabilities per component and keeps alerts through an incomplete scan', () => {
    const report = (version: string, errors: unknown[] = [], severity = 'high') => ({
      site: SITE.id,
      ok: true,
      data: {
        checked_at: 'x', checked: { core: true, plugins: 2, themes: 1 }, errors,
        summary: { critical: 0, high: 1, medium: 0, low: 1, unknown: 0, total: 2 },
        findings: version
          ? [
              { type: 'plugin', slug: 'contact-form-7', name: 'Contact Form 7', version, vulnerabilities: [
                { id: 'a', name: 'Upload', severity, affected: '< 5.8.4', fixedIn: '5.8.4', unfixed: false, references: [] },
                { id: 'b', name: 'XSS', severity: 'medium', affected: '< 5.8.2', fixedIn: '5.8.2', unfixed: false, references: [] },
              ] },
              { type: 'theme', slug: 'old', version: '1.0', vulnerabilities: [{ id: 'c', name: 'Low', severity: 'low', affected: '', unfixed: false, references: [] }] },
            ]
          : [],
      },
    });
    const opened = snap(db, 'fleet_vulnerabilities', report('5.8'));
    expect(summary(opened)).toEqual(['opened:vulnerable']);
    expect(opened[0]!.alert).toMatchObject({ severity: 'critical', title: 'Kwetsbare plugin: Contact Form 7 5.8' });
    expect(JSON.parse(opened[0]!.alert.details!)).toMatchObject({ count: 2, fixedIn: '5.8.4', worst: 'high' });
    // Partially updated, still vulnerable: same alert, updated title, no new notification.
    expect(snap(db, 'fleet_vulnerabilities', report('5.8.2', [], 'medium'))).toEqual([]);
    expect(db.activeAlerts()[0]).toMatchObject({ title: 'Kwetsbare plugin: Contact Form 7 5.8.2', severity: 'warning' });
    expect(snap(db, 'fleet_vulnerabilities', report('', [{ type: 'plugin', slug: 'contact-form-7', error: 'HTTP 502' }]))).toEqual([]);
    expect(summary(snap(db, 'fleet_vulnerabilities', report('')))).toEqual(['resolved:vulnerable']);
  });

  it('flags critical Site Health tests individually', () => {
    const health = (critical: string[]) => ({
      site: SITE.id, ok: true,
      data: { summary: {}, tests: critical.map((test) => ({ test, label: `Test ${test}`, status: 'critical' })).concat([{ test: 'ok', label: 'ok', status: 'good' }]) },
    });
    expect(summary(snap(db, 'fleet_site_health', health(['php', 'https'])))).toEqual(['opened:health_critical', 'opened:health_critical']);
    expect(summary(snap(db, 'fleet_site_health', health(['php'])))).toEqual(['resolved:health_critical']);
    expect(db.activeAlerts()[0]!.title).toBe('Site Health kritiek: Test php');
  });

  it('warns when n8n stops delivering', () => {
    expect(evaluateStaleData(db, 3, t)).toEqual([]);
    db.insertSnapshot(null, 'fleet_health', '{}', new Date().toISOString());
    const received = Date.parse(db.lastSnapshotReceivedAt()!);
    expect(evaluateStaleData(db, 3, received + 2 * HOUR)).toEqual([]);
    const opened = evaluateStaleData(db, 3, received + 4 * HOUR);
    expect(summary(opened)).toEqual(['opened:stale_data']);
    expect(opened[0]!.alert.title).toBe('Al 4 uur geen data van n8n ontvangen');
    expect(summary(evaluateStaleData(db, 3, received + HOUR))).toEqual(['resolved:stale_data']);
  });

  it('acknowledging a state alert mutes it until its condition is gone', () => {
    snap(db, 'fleet_health', { ...healthy, data: { ...healthy.data, roles: ['editor'] } });
    const alert = db.activeAlerts()[0]!;
    expect(acknowledgeAlert(db, alert.id, 'me')!.status).toBe('acknowledged');
    expect(db.openAlertCounts().size).toBe(0);
    expect(summary(snap(db, 'fleet_health', healthy))).toEqual(['resolved:not_admin']);
    expect(acknowledgeAlert(db, alert.id, 'me')).toBeUndefined();
  });

  it('drops alerts of sites that no longer exist', () => {
    snap(db, 'fleet_health', { ...healthy, data: { ...healthy.data, roles: ['editor'] } });
    db.deleteAlertsOfUnknownSites([SITE.id]);
    expect(db.activeAlerts()).toHaveLength(1);
    db.deleteAlertsOfUnknownSites([]);
    expect(db.activeAlerts()).toEqual([]);
  });
});

describe('dashboard db migration', () => {
  it('adds the alerts table to an existing v1 database without touching its data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    try {
      const path = join(dir, 'dashboard.db');
      const v1 = new DashboardDb(path);
      v1.insertSnapshot('klant-a', 'fleet_health', '{}', '2026-09-01T00:00:00Z');
      v1.db.exec('DROP TABLE alerts; PRAGMA user_version = 1;');
      v1.close();
      const migrated = new DashboardDb(path);
      expect(migrated.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
      expect(migrated.recentSnapshots('klant-a', 'fleet_health')).toHaveLength(1);
      expect(migrated.activeAlerts()).toEqual([]);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AlertNotifier', () => {
  it('posts one batched, Slack-compatible message and never leaks the URL on failure', async () => {
    const db = new DashboardDb(':memory:');
    snap(db, 'fleet_health', { ...healthy, data: { ...healthy.data, roles: ['editor'] } });
    const changes = snap(db, 'fleet_health', { ...healthy, data: { ...healthy.data, roles: ['editor'], bridge: 'missing' } });
    const posts: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const notifier = new AlertNotifier({
      url: 'https://hooks.slack.com/services/T/B/secret',
      token: 'tok',
      publicUrl: 'https://wp-dashboard.jtit.nl/',
      siteName: () => 'Klant A',
      fetch: createMockFetch((url, init) => {
        posts.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return new Response('ok');
      }),
    });
    expect(await notifier.send([])).toBe(false);
    expect(await notifier.send(changes)).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers.get('authorization')).toBe('Bearer tok');
    expect(posts[0]!.body.text).toBe('WP Fleet\n🟠 Klant A: nb-mcp-bridge ontbreekt op de site\nMeldingen: https://wp-dashboard.jtit.nl/alerts');
    expect(posts[0]!.body.opened).toMatchObject([{ site: 'klant-a', siteName: 'Klant A', type: 'bridge_problem', url: 'https://wp-dashboard.jtit.nl/sites/klant-a#alerts' }]);

    const logs: string[] = [];
    const failing = new AlertNotifier({
      url: 'https://hooks.slack.com/services/T/B/secret',
      log: (l) => logs.push(l),
      fetch: createMockFetch(() => {
        throw new Error('connect ECONNREFUSED https://hooks.slack.com/services/T/B/secret');
      }),
    });
    expect(await failing.send(changes)).toBe(false);
    expect(logs.join()).toContain('<webhook>');
    expect(logs.join()).not.toContain('secret');
    expect(await new AlertNotifier({}).sendTest()).toEqual({ ok: false, message: 'ALERT_WEBHOOK_URL is niet ingesteld.' });
    db.close();
  });
});

describe('dashboard: alerts and vulnerabilities', () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const INGEST = 'i'.repeat(40);
  const ingest = (base: string, body: unknown) =>
    fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<{ data: { alerts: { opened: number; resolved: number } } }>);

  function fakeWorld() {
    const webhooks: Array<Record<string, unknown>> = [];
    const wpFetch = createMockFetch((url, init) => {
      if (url.startsWith('https://hooks.example.com/')) {
        webhooks.push(JSON.parse(String(init?.body)));
        return new Response('ok');
      }
      if (url.startsWith(WPVULNERABILITY_API)) {
        if (url.endsWith('/plugin/contact-form-7/')) {
          return jsonResponse({ data: { vulnerability: [{ uuid: 'x', name: 'CF7 upload', operator: { max_version: '5.8.4', max_operator: 'lt', unfixed: '0' }, impact: { cvss: { severity: 'c', score: '9.8' } } }] } });
        }
        return jsonResponse({}, { status: 404 });
      }
      const p = new URL(url).pathname;
      if (p.endsWith('/wp/v2/plugins')) return jsonResponse([{ plugin: 'contact-form-7/wp-contact-form-7', name: 'Contact Form 7', version: '5.8', status: 'active' }]);
      if (p.endsWith('/wp/v2/themes')) return jsonResponse([]);
      if (p.endsWith('/nb-mcp/v1/status')) return jsonResponse({ bridge_version: '1.2.0', wp_version: '6.8.3' });
      return jsonResponse({ code: 'rest_no_route' }, { status: 404 });
    });
    return { webhooks, wpFetch };
  }

  it('turns ingested data into alerts, notifies the webhook and lets you acknowledge them', async () => {
    const { webhooks, wpFetch } = fakeWorld();
    app = await startApp(wpFetch, { ALERT_WEBHOOK_URL: 'https://hooks.example.com/wp', DASHBOARD_PUBLIC_URL: 'https://wp-dashboard.jtit.nl' });
    app.store.upsert({ id: 'klant-a', name: 'Klant A', url: 'https://klant-a.nl', username: 'mcp-bot' }, 'pw');
    const users = (names: string[]) => ({ kind: 'fleet_user_audit', data: { results: [{ site: 'klant-a', ok: true, users: names.map((n, i) => ({ id: i, username: n, roles: ['administrator'] })) }] } });
    expect((await ingest(app.base, users(['mcp-bot']))).data.alerts).toEqual({ opened: 0, resolved: 0 });
    expect((await ingest(app.base, users(['mcp-bot', 'hacker']))).data.alerts).toEqual({ opened: 1, resolved: 0 });
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]!.text).toContain('🔴 Klant A: Nieuw administrator-account: hacker');

    const browser = await loginAndEnroll(app.base);
    const overview = await (await browser.get('/')).text();
    expect(overview).toMatch(/href="\/alerts"[^>]*>.*Meldingen<\/span><span class="nav-count alert"[^>]*>1<\/span>/s);
    const page = await (await browser.get('/alerts')).text();
    expect(page).toContain('Nieuw administrator-account: hacker');
    const detail = await (await browser.get('/sites/klant-a')).text();
    expect(detail).toContain('id="alerts"');
    const id = /action="\/alerts\/(\d+)\/ack"/.exec(page)![1]!;
    const res = await browser.post(`/alerts/${id}/ack`, { _csrf: csrfOf(page), back: '//evil.example.com' });
    expect(res.headers.get('location')).toBe('/alerts');
    const after = await (await browser.get('/alerts')).text();
    expect(after).toContain('Geen actieve meldingen');
    expect(after).toContain('gezien door admin@jtit.nl');
    expect(await (await browser.get('/audit')).text()).toContain('alert_acknowledged');

    const settings = await (await browser.get('/settings')).text();
    expect(settings).toContain('ingesteld');
    const tested = await (await browser.post('/settings/alerts/test', { _csrf: csrfOf(settings) })).text();
    expect(tested).toContain('Testmelding verstuurd.');
    expect(webhooks.at(-1)).toMatchObject({ test: true });
  });

  it('scans a site on demand and shows the findings with the fixing update', async () => {
    const { wpFetch } = fakeWorld();
    app = await startApp(wpFetch);
    app.store.upsert({ id: 'klant-a', name: 'Klant A', url: 'https://klant-a.nl', username: 'mcp-bot' }, 'pw');
    await ingest(app.base, {
      kind: 'fleet_updates_report',
      data: { results: [{ site: 'klant-a', ok: true, data: { plugins: [{ plugin: 'contact-form-7/wp-contact-form-7.php', current_version: '5.8', new_version: '5.9' }] } }] },
    });
    const browser = await loginAndEnroll(app.base);
    const empty = await (await browser.get('/vulnerabilities')).text();
    expect(empty).toContain('Nog geen scans ontvangen');
    const detail = await (await browser.get('/sites/klant-a')).text();
    expect(detail).toContain('Nog niet gescand');
    const res = await browser.post('/sites/klant-a/vulnerabilities/refresh', { _csrf: csrfOf(detail) });
    expect(res.headers.get('location')).toBe('/sites/klant-a?scanned=1#vulnerabilities');
    const scanned = await (await browser.get('/sites/klant-a?scanned=1')).text();
    expect(scanned).toContain('Kwetsbaarheden gescand.');
    expect(scanned).toContain('CF7 upload');
    expect(scanned).toContain('update naar 5.9 lost dit op');
    expect(scanned).toMatch(/<details class="panel" id="vulnerabilities" data-persist="vulnerabilities" open>/);
    // The scan also raised an alert (critical vulnerability) without a webhook configured.
    expect(app.db.activeAlerts({ siteId: 'klant-a' }).map((a) => a.title)).toEqual(['Kwetsbare plugin: Contact Form 7 5.8']);
    const fleet = await (await browser.get('/vulnerabilities')).text();
    expect(fleet).toContain('1 van 1 sites gescand');
    expect(fleet).toContain('Contact Form 7');
    expect(fleet).toContain('kritiek');
    const overview = await (await browser.get('/')).text();
    expect(overview).toContain('1 kritiek/hoog');

    // Deleting the site removes its alerts too.
    await browser.post('/sites/klant-a/delete', { _csrf: csrfOf(overview), confirm: 'on' });
    expect(app.db.activeAlerts()).toEqual([]);
  });
});
