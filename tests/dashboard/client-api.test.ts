import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { siteConfigSchema } from '../../src/config/schema.js';
import { buildFleetView, buildSiteView, deriveIssues, deriveState, type ClientStatus } from '../../src/dashboard/client-api.js';
import { DashboardDb } from '../../src/dashboard/db.js';
import { SiteStore } from '../../src/store/site-store.js';
import { vulnSnapshotPayload, VULN_KIND, type VulnItem } from '../../src/vuln/items.js';
import { FIXTURE_NOW, fixtureFeed, seedFixtureFleet } from './client-api-fixture.js';

const GOLDEN = fileURLToPath(new URL('../fixtures/client-api-fleet.json', import.meta.url));

const emptyStatus: ClientStatus = {
  collectedAt: null, reachable: null, isAdmin: null, bridge: null, wpVersion: null, phpVersion: null,
  error: null, updates: null, updatesError: null, health: null, healthError: null,
};

const vuln = (overrides: Partial<VulnItem> = {}): VulnItem => ({
  id: 'v1', title: 'X <= 1.0 - XSS', softwareType: 'plugin', slug: 'x', softwareName: 'X', installedVersion: '1.0',
  cve: null, cvssScore: null, cvssRating: null, patched: false, patchedVersions: [], remediation: null, reference: null, published: null,
  ...overrides,
});

describe('client API derivation', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const fresh = '2026-10-16T11:00:00Z';

  it('flags missing passwords, unreachable sites and missing data', () => {
    const issues = deriveIssues({ hasPassword: false }, { ...emptyStatus, collectedAt: fresh, reachable: false, error: 'timeout' }, null, null, now);
    expect(issues).toEqual([
      { severity: 'critical', code: 'no-password', message: 'Geen Application Password opgeslagen' },
      { severity: 'critical', code: 'unreachable', message: 'Site niet bereikbaar: timeout' },
    ]);
    expect(deriveIssues({ hasPassword: true }, emptyStatus, null, null, now)).toEqual([
      { severity: 'info', code: 'stale', message: 'Nog geen gegevens ontvangen' },
    ]);
    expect(deriveIssues({ hasPassword: true }, { ...emptyStatus, reachable: false }, null, null, now)[0]!.message).toBe('Site niet bereikbaar: onbekende fout');
  });

  it('rates vulnerabilities by CVSS score or rating', () => {
    const items = [
      vuln({ cvssScore: 7.0 }),
      vuln({ cvssRating: 'Critical', cve: 'CVE-2025-1' }),
      vuln({ cvssScore: 6.9, cvssRating: 'Medium' }),
      vuln({ cvssRating: 'Low' }),
      vuln(),
    ];
    const issues = deriveIssues({ hasPassword: true }, { ...emptyStatus, collectedAt: fresh, reachable: true }, null, { scannedAt: fresh, error: null, items }, now);
    expect(issues.map((i) => [i.severity, i.message])).toEqual([
      ['critical', 'X 1.0: X <= 1.0 - XSS (CVSS 7.0)'],
      ['critical', 'X 1.0: CVE-2025-1 (Critical)'],
      ['warning', 'X 1.0: X <= 1.0 - XSS (CVSS 6.9, Medium)'],
      ['warning', 'X 1.0: X <= 1.0 - XSS (Low)'],
      ['warning', 'X 1.0: X <= 1.0 - XSS'],
    ]);
  });

  it('reports updates, Site Health, stale data and failed checks in order', () => {
    const status: ClientStatus = {
      ...emptyStatus, collectedAt: '2026-10-16T05:59:59Z', reachable: true,
      updates: { core: 1, plugins: 1, themes: 2 }, health: { critical: 2, recommended: 0, good: 1 },
      updatesError: 'HTTP 500', healthError: 'bridge te oud',
    };
    const issues = deriveIssues({ hasPassword: true }, status, null, { scannedAt: fresh, error: 'Kwetsbaarhedenscan mislukt: x', items: [] }, now);
    expect(issues).toEqual([
      { severity: 'warning', code: 'core-update', message: 'WordPress-update beschikbaar' },
      { severity: 'warning', code: 'updates', message: '1 plugin-update en 2 thema-updates beschikbaar' },
      { severity: 'warning', code: 'health-critical', message: 'Site Health: 2 kritieke problemen' },
      { severity: 'info', code: 'stale', message: 'Gegevens zijn verouderd (laatste: 2026-10-16T05:59:59Z)' },
      { severity: 'info', code: 'check-failed', message: 'Update-check mislukt: HTTP 500' },
      { severity: 'info', code: 'check-failed', message: 'Site Health-check mislukt: bridge te oud' },
      { severity: 'info', code: 'check-failed', message: 'Kwetsbaarhedenscan mislukt: x' },
    ]);
    // Exactly 6 hours old is not stale yet.
    const sixHours = deriveIssues({ hasPassword: true }, { ...emptyStatus, collectedAt: '2026-10-16T06:00:00Z', reachable: true }, null, null, now);
    expect(sixHours).toEqual([]);
  });

  it('derives the state', () => {
    const info = [{ severity: 'info' as const, code: 'stale' as const, message: '' }];
    expect(deriveState([{ severity: 'warning', code: 'updates', message: '' }, { severity: 'critical', code: 'unreachable', message: '' }], emptyStatus)).toBe('critical');
    expect(deriveState([{ severity: 'warning', code: 'updates', message: '' }], emptyStatus)).toBe('warning');
    expect(deriveState(info, { ...emptyStatus, reachable: true })).toBe('ok');
    expect(deriveState(info, emptyStatus)).toBe('unknown');
  });
});

describe('client API views', () => {
  let db: DashboardDb;
  let store: SiteStore;
  beforeEach(() => {
    db = new DashboardDb(':memory:');
    store = new SiteStore(':memory:', randomBytes(32));
  });
  afterEach(() => {
    db.close();
    store.close();
  });

  it('renders a site without any data with explicit nulls', () => {
    store.upsert(siteConfigSchema.parse({ id: 'leeg', name: 'Leeg', url: 'https://leeg.nl', username: 'mcp-bot' }));
    const view = buildSiteView(store.list()[0]!, [], FIXTURE_NOW);
    expect(view).toEqual({
      id: 'leeg', name: 'Leeg', url: 'https://leeg.nl', tags: [], hasPassword: false, multisite: false, state: 'critical',
      issues: [
        { severity: 'critical', code: 'no-password', message: 'Geen Application Password opgeslagen' },
        { severity: 'info', code: 'stale', message: 'Nog geen gegevens ontvangen' },
      ],
      status: emptyStatus,
      updates: null,
      vulnerabilities: null,
    });
  });

  it('keeps previous items and reports the error of a failed scan; failed update checks give empty lists', () => {
    store.upsert(siteConfigSchema.parse({ id: 'fout', name: 'Fout', url: 'https://fout.nl', username: 'mcp-bot' }), 'pw');
    const previous = { scannedAt: '2026-10-16T00:00:00.000Z', items: [vuln({ cvssScore: 9.8 })] };
    db.insertSnapshot('fout', VULN_KIND, vulnSnapshotPayload('fout', { error: 'Kwetsbaarhedenscan mislukt: x', previous }), '2026-10-16T06:00:00.000Z');
    db.insertSnapshot('fout', 'fleet_updates_report', JSON.stringify({ site: 'fout', ok: false, error: '<b>HTTP</b> 500' }), '2026-10-16T09:00:00.000Z');
    const view = buildSiteView(store.list()[0]!, db.latestSnapshots('fout'), FIXTURE_NOW);
    expect(view.vulnerabilities).toEqual({ scannedAt: '2026-10-16T06:00:00.000Z', error: 'Kwetsbaarhedenscan mislukt: x', items: previous.items });
    expect(view.updates).toEqual({ checkedAt: '2026-10-16T09:00:00.000Z', core: [], plugins: [], themes: [] });
    expect(view.status.updatesError).toBe('HTTP 500');
    expect(view.state).toBe('critical');
  });

  it('builds the fleet view (golden file shared with the macOS client)', async () => {
    const feed = await fixtureFeed();
    await seedFixtureFleet(store, db, feed);
    const fleet = buildFleetView({ sites: store.list(), snapshots: db.latestSnapshots(), feed: feed.status(), now: FIXTURE_NOW });

    expect(fleet.summary).toEqual({
      sites: 3, ok: 1, warning: 1, critical: 1, unknown: 0, pendingUpdates: 4, vulnerabilities: 3, criticalVulnerabilities: 1,
    });
    expect(fleet.sites.map((s) => [s.id, s.state])).toEqual([['klant-a', 'critical'], ['klant-b', 'warning'], ['klant-c', 'ok']]);
    const [a, b, c] = fleet.sites;
    expect(a!.issues).toEqual([
      { severity: 'critical', code: 'vulnerability', message: 'Contact Form 7 5.8.1: CVE-2024-1234 (CVSS 8.1, High)' },
      { severity: 'warning', code: 'vulnerability', message: 'WordPress 6.8.2: CVE-2025-0001 (CVSS 6.4, Medium)' },
      { severity: 'warning', code: 'core-update', message: 'WordPress-update beschikbaar: 6.8.3' },
      { severity: 'warning', code: 'updates', message: '2 plugin-updates beschikbaar' },
    ]);
    expect(a!.updates).toEqual({
      checkedAt: '2026-10-16T09:00:00.000Z',
      core: [{ current: '6.8.2', version: '6.8.3', type: 'minor' }],
      plugins: [
        { slug: 'contact-form-7', name: 'Contact Form 7', currentVersion: '5.8.1', newVersion: '6.0.1' },
        { slug: 'hello', name: 'Hello Dolly', currentVersion: '1.7.1', newVersion: '1.7.2' },
      ],
      themes: [],
    });
    expect(b!.issues.map((i) => i.code)).toEqual(['vulnerability', 'updates', 'health-critical']);
    expect(c!.issues).toEqual([]);
    expect(c!.vulnerabilities).toEqual({ scannedAt: '2026-10-16T06:05:00.000Z', error: null, items: [] });

    const json = `${JSON.stringify({ success: true, data: fleet }, null, 2)}\n`;
    if (process.env.UPDATE_FIXTURES === '1' || !existsSync(GOLDEN)) writeFileSync(GOLDEN, json);
    expect(json).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});
