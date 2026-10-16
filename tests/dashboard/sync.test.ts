import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dashboardEnvSchema, siteConfigSchema } from '../../src/config/schema.js';
import { buildSiteView } from '../../src/dashboard/client-api.js';
import { DashboardDb } from '../../src/dashboard/db.js';
import { HEALTH_KIND } from '../../src/dashboard/health.js';
import { storeIngest, summarizeSite } from '../../src/dashboard/snapshots.js';
import { isSyncDue, runSyncCycle, runSyncTask, startSyncScheduler, type SyncDeps, type SyncKind } from '../../src/dashboard/sync.js';
import { SiteStore } from '../../src/store/site-store.js';
import { WpClient } from '../../src/wp/client.js';
import { createHarness, createMockFetch, jsonResponse } from '../helpers/harness.js';

const PASSWORD = 'Zeer-Geheim-App-Wachtwoord-42';
const HOUR = 3_600_000;
const SCHEDULE = { healthIntervalMs: HOUR, updatesIntervalMs: 6 * HOUR };

const HEALTH = {
  checked_at: '2026-10-16T09:00:00Z',
  summary: { critical: 1, recommended: 2, good: 17 },
  tests: [{ test: 'php_version', label: 'PHP', status: 'critical', badge: { label: 'Beveiliging', color: 'red' }, description: 'x', actions: [] }],
  info: { wp_version: '6.8.3' },
};

/**
 * Fake fleet: `klant-a` healthy with bridge, `klant-b` unreachable (network error),
 * `klant-c` without bridge. Records every request path.
 */
function fakeFleet() {
  const calls: string[] = [];
  const fetch = createMockFetch((url) => {
    const u = new URL(url);
    calls.push(`${u.host}${u.pathname}${u.searchParams.has('include_sizes') ? '?sizes' : ''}${u.searchParams.has('refresh') ? '?refresh' : ''}`);
    if (u.host.startsWith('klant-b')) throw new TypeError('fetch failed');
    const p = u.pathname;
    if (p.endsWith('/wp/v2/users/me')) return jsonResponse({ id: 3, username: 'mcp-bot', roles: ['administrator'] });
    if (p.endsWith('/nb-mcp/v1/status')) {
      return jsonResponse({ bridge_version: '1.2.0', wp_version: '6.8.2', php_version: '8.3.12', multisite: false, features: ['safe_updates', 'site_health', 'network'] });
    }
    if (p.endsWith('/nb-mcp/v1/updates')) {
      return jsonResponse({
        checked_at: '2026-10-16T09:00:00Z',
        core: [{ current: '6.8.2', version: '6.8.3', response: 'upgrade', type: 'minor' }],
        plugins: [{ plugin: 'akismet/akismet.php', name: 'Akismet', current_version: '5.3', new_version: '5.4' }],
        themes: [],
        translations: { count: 0 },
      });
    }
    if (p.endsWith('/nb-mcp/v1/site-health')) return jsonResponse(HEALTH);
    return jsonResponse({ code: 'rest_no_route', message: 'No route' }, { status: 404 });
  });
  return { fetch, calls };
}

describe('built-in sync', () => {
  let db: DashboardDb;
  let store: SiteStore;
  let logs: string[];

  const deps = (fetch: ReturnType<typeof fakeFleet>['fetch'], now?: () => Date): SyncDeps => ({
    db, store, now, clientFor: (site) => new WpClient(site, { fetch }), log: (m) => logs.push(m),
  });

  beforeEach(() => {
    db = new DashboardDb(':memory:');
    store = new SiteStore(':memory:', randomBytes(32));
    logs = [];
    const add = (id: string, opts: { bridge?: boolean; password?: string } = {}) =>
      store.upsert(siteConfigSchema.parse({ id, name: id, url: `https://${id}.nl`, username: 'mcp-bot', bridge: opts.bridge ?? true }), opts.password);
    add('klant-a', { password: PASSWORD });
    add('klant-b', { password: PASSWORD });
    add('klant-c', { password: PASSWORD, bridge: false });
    add('zonder-wachtwoord');
  });
  afterEach(() => {
    db.close();
    store.close();
  });

  it('stores exactly what n8n would ingest from the MCP fleet tools', async () => {
    const fleet = fakeFleet();
    const at = new Date('2026-10-16T09:00:00.000Z');
    await runSyncCycle(deps(fleet.fetch, () => at), SCHEDULE);

    // Reference: call the MCP tools over the same fake fleet and ingest like n8n does.
    const reference = new DashboardDb(':memory:');
    const harness = await createHarness({ sites: store.load(), fetch: fleet.fetch });
    try {
      const calls: Array<[SyncKind, string, Record<string, unknown>]> = [
        ['fleet_health', 'fleet_health', {}],
        ['fleet_updates_report', 'fleet_updates_report', { refresh: true }],
        [HEALTH_KIND, 'fleet_site_health', {}],
      ];
      for (const [kind, tool, args] of calls) {
        const result = await harness.client.callTool({ name: tool, arguments: args });
        const text = (result.content as Array<{ text: string }>)[0]!.text;
        storeIngest(reference, { kind, collectedAt: at.toISOString(), data: JSON.parse(text) }, new Set(store.list().map((s) => s.id)));
      }
    } finally {
      await harness.close();
    }

    const rows = (d: DashboardDb) =>
      d.latestSnapshots().map((r) => ({ site: r.site_id, kind: r.kind, collectedAt: r.collected_at, data: JSON.parse(r.data) }));
    expect(rows(db)).toEqual(rows(reference));
    reference.close();

    // Shape spot checks: per-site rows + a fleet-wide row, unavailable sites never contacted.
    const health = db.latestSnapshots('klant-a').find((r) => r.kind === 'fleet_health')!;
    expect(JSON.parse(health.data)).toEqual({
      site: 'klant-a', ok: true,
      data: { ok: true, user: { id: 3, username: 'mcp-bot' }, roles: ['administrator'], bridge: 'ok', versions: expect.objectContaining({ wp_version: '6.8.2' }) },
    });
    const fleetRow = db.latestSnapshots(null).find((r) => r.kind === 'fleet_health')!;
    expect(JSON.parse(fleetRow.data).summary).toEqual({ sites: 3, ok: 2, failed: 1, skipped: 1 });
    expect(JSON.parse(fleetRow.data).skipped).toEqual([{ site: 'zonder-wachtwoord', reason: expect.any(String) }]);
    expect(db.latestSnapshots('zonder-wachtwoord')).toEqual([]);
    expect(db.latestSnapshots('klant-c').map((r) => r.kind)).toEqual(['fleet_health', 'fleet_updates_report']); // no bridge: no Site Health
    expect(fleet.calls).toContain('klant-a.nl/wp-json/nb-mcp/v1/updates?refresh');
    expect(fleet.calls).toContain('klant-a.nl/wp-json/nb-mcp/v1/site-health?sizes');
  });

  it('makes sites fresh for the client API and the dashboard status', async () => {
    const now = new Date();
    await runSyncCycle(deps(fakeFleet().fetch, () => now), SCHEDULE);
    const site = store.list().find((s) => s.id === 'klant-a')!;
    const status = summarizeSite(db.latestSnapshots('klant-a'));
    expect(status).toMatchObject({ reachable: true, isAdmin: true, wpVersion: '6.8.2', updates: { core: 1, plugins: 1, themes: 0 }, health: { critical: 1, recommended: 2, good: 17 } });
    const view = buildSiteView(site, db.latestSnapshots('klant-a'), now);
    expect(view.issues.map((i) => i.code)).not.toContain('stale');
    expect(view.issues.map((i) => i.code)).toEqual(['core-update', 'updates', 'health-critical']);
    expect(view.state).toBe('warning');
  });

  it('isolates per-site errors and never logs secrets', async () => {
    const results = await runSyncCycle(deps(fakeFleet().fetch), SCHEDULE);
    expect(results).toEqual([
      { kind: 'fleet_health', sites: 3, failed: 1, skipped: 1, stored: 4 },
      { kind: 'fleet_updates_report', sites: 3, failed: 2, skipped: 1, stored: 4 },
      { kind: HEALTH_KIND, sites: 2, failed: 1, skipped: 2, stored: 3 },
    ]);
    const b = JSON.parse(db.latestSnapshots('klant-b').find((r) => r.kind === 'fleet_health')!.data);
    expect(b).toMatchObject({ site: 'klant-b', ok: true, data: { ok: false, bridge: 'error', error: expect.stringContaining('failed') } });
    expect(summarizeSite(db.latestSnapshots('klant-b')).reachable).toBe(false);
    const bUpdates = JSON.parse(db.latestSnapshots('klant-b').find((r) => r.kind === 'fleet_updates_report')!.data);
    expect(bUpdates).toMatchObject({ site: 'klant-b', ok: false, error: expect.any(String) });
    expect(logs).toEqual([
      'sync fleet_health: 3 site(s), 1 failed, 1 skipped',
      'sync fleet_updates_report: 3 site(s), 2 failed, 1 skipped',
      'sync fleet_site_health: 2 site(s), 1 failed, 2 skipped',
    ]);
    const everything = logs.join('\n') + db.latestSnapshots().map((r) => r.data).join('\n');
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(Buffer.from(`mcp-bot:${PASSWORD}`).toString('base64'));
  });

  it('keeps going when one task throws', async () => {
    const d = deps(fakeFleet().fetch);
    const broken = { ...d, store: { load: () => { throw new Error('store kapot'); } } as unknown as SiteStore };
    expect(await runSyncCycle(broken, SCHEDULE)).toEqual([]);
    expect(logs).toEqual(['sync fleet_health failed: store kapot', 'sync fleet_updates_report failed: store kapot', 'sync fleet_site_health failed: store kapot']);
  });

  it('only runs what is due (restarts and n8n data count)', async () => {
    let now = new Date('2026-10-16T09:00:00.000Z');
    const fleet = fakeFleet();
    const d = deps(fleet.fetch, () => now);
    expect((await runSyncCycle(d, SCHEDULE)).map((r) => r.kind)).toEqual(['fleet_health', 'fleet_updates_report', HEALTH_KIND]);

    // Right after a restart nothing is due, so no site is contacted.
    const before = fleet.calls.length;
    expect(await runSyncCycle(d, SCHEDULE)).toEqual([]);
    expect(fleet.calls.length).toBe(before);

    now = new Date(now.getTime() + HOUR);
    expect((await runSyncCycle(d, SCHEDULE)).map((r) => r.kind)).toEqual(['fleet_health']);
    now = new Date(Date.parse('2026-10-16T09:00:00.000Z') + 6 * HOUR - 30_000); // within the grace margin
    expect((await runSyncCycle(d, SCHEDULE)).map((r) => r.kind)).toEqual(['fleet_health', 'fleet_updates_report', HEALTH_KIND]);
    expect((await runSyncCycle(d, SCHEDULE, { force: true })).map((r) => r.kind)).toHaveLength(3);
  });

  it('decides due-ness from fleet-wide rows only', () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    expect(isSyncDue(db, 'fleet_health', HOUR, now)).toBe(true);
    // A manual refresh of one site (per-site row only) does not postpone the fleet run.
    db.insertSnapshot('klant-a', 'fleet_health', '{}', '2026-10-16T11:59:00.000Z');
    expect(isSyncDue(db, 'fleet_health', HOUR, now)).toBe(true);
    // An n8n run (fleet-wide row) does.
    db.insertSnapshot(null, 'fleet_health', '{}', '2026-10-16T11:30:00.000Z');
    expect(isSyncDue(db, 'fleet_health', HOUR, now)).toBe(false);
    expect(isSyncDue(db, 'fleet_health', HOUR, new Date('2026-10-16T12:29:30.000Z'))).toBe(true);
  });

  it('runs a single task on demand', async () => {
    const result = await runSyncTask('fleet_updates_report', deps(fakeFleet().fetch));
    expect(result).toEqual({ kind: 'fleet_updates_report', sites: 3, failed: 2, skipped: 1, stored: 4 });
  });

  it('scheduler: first tick after 30 s, then every shortest interval, without overlapping', async () => {
    vi.useFakeTimers();
    try {
      const fleet = fakeFleet();
      const d = deps(fleet.fetch);
      startSyncScheduler(d, { healthIntervalMs: 10 * 60_000, updatesIntervalMs: HOUR });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(fleet.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(logs).toHaveLength(3));
      // 10 minutes later only fleet_health is due again.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await vi.waitFor(() => expect(logs).toHaveLength(4));
      expect(logs[3]).toMatch(/^sync fleet_health:/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sync env', () => {
  const base = { SITES_ENCRYPTION_KEY: 'x', DASHBOARD_INGEST_TOKEN: 'i'.repeat(40) };

  it('is enabled by default and disabled only by "false"', () => {
    const parse = (extra: Record<string, string>) => dashboardEnvSchema.parse({ ...base, ...extra });
    expect(parse({})).toMatchObject({ DASHBOARD_SYNC_ENABLED: true, SYNC_HEALTH_INTERVAL_MINUTES: 60, SYNC_UPDATES_INTERVAL_HOURS: 6 });
    expect(parse({ DASHBOARD_SYNC_ENABLED: 'false' }).DASHBOARD_SYNC_ENABLED).toBe(false);
    expect(parse({ DASHBOARD_SYNC_ENABLED: ' FALSE ' }).DASHBOARD_SYNC_ENABLED).toBe(false);
    expect(parse({ DASHBOARD_SYNC_ENABLED: 'true' }).DASHBOARD_SYNC_ENABLED).toBe(true);
    expect(parse({ SYNC_HEALTH_INTERVAL_MINUTES: '15', SYNC_UPDATES_INTERVAL_HOURS: '12' })).toMatchObject({ SYNC_HEALTH_INTERVAL_MINUTES: 15, SYNC_UPDATES_INTERVAL_HOURS: 12 });
    expect(dashboardEnvSchema.safeParse({ ...base, SYNC_HEALTH_INTERVAL_MINUTES: '0' }).success).toBe(false);
  });
});
