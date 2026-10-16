import type { ResolvedSite } from '../config/schema.js';
import type { SiteStore } from '../store/site-store.js';
import { fleetHealthReport, fleetSiteHealthReport, fleetUpdatesReport, type ClientOf } from '../tools/fleet-reports.js';
import type { SkippedSite } from '../tools/helpers.js';
import type { DashboardDb } from './db.js';
import { HEALTH_KIND } from './health.js';
import { storeIngest } from './snapshots.js';

/**
 * Built-in sync: the dashboard collects `fleet_health`, `fleet_updates_report` (with refresh)
 * and `fleet_site_health` itself, in exactly the shape n8n posts to `/api/ingest` (a per-site
 * row per result plus a fleet-wide row). n8n is optional; both can run side by side.
 */

export type SyncKind = 'fleet_health' | 'fleet_updates_report' | typeof HEALTH_KIND;

export const SYNC_CONCURRENCY = 3;
const START_DELAY_MS = 30_000;
const MIN_GRACE_MS = 60_000;

export interface SyncDeps {
  db: DashboardDb;
  store: SiteStore;
  clientFor: ClientOf;
  concurrency?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface SyncSchedule {
  healthIntervalMs: number;
  updatesIntervalMs: number;
}

export interface SyncTaskResult {
  kind: SyncKind;
  sites: number;
  failed: number;
  skipped: number;
  stored: number;
}

/** Timers fire a little early or late; a run counts as due within this margin of its interval. */
const grace = (intervalMs: number): number => Math.max(MIN_GRACE_MS, intervalMs * 0.05);

/** True when the newest fleet-wide snapshot of `kind` (from n8n or this sync) is older than the interval. */
export function isSyncDue(db: DashboardDb, kind: SyncKind, intervalMs: number, now: Date): boolean {
  const last = db.latestFleetCollectedAt(kind);
  return !last || now.getTime() - Date.parse(last) >= intervalMs - grace(intervalMs);
}

function partition(sites: ResolvedSite[]): { selected: ResolvedSite[]; skipped: SkippedSite[] } {
  return {
    selected: sites.filter((s) => s.available),
    skipped: sites.filter((s) => !s.available).map((s) => ({ site: s.id, reason: s.unavailableReason ?? 'site is unavailable' })),
  };
}

/** Runs one report over every site with a password and stores it like `/api/ingest` would. */
export async function runSyncTask(kind: SyncKind, deps: SyncDeps): Promise<SyncTaskResult> {
  // The sampling start, not the end, so the interval between runs stays stable.
  const collectedAt = (deps.now?.() ?? new Date()).toISOString();
  const all = deps.store.load();
  const { selected, skipped } = partition(all);
  const concurrency = deps.concurrency ?? SYNC_CONCURRENCY;
  const report =
    kind === 'fleet_health'
      ? await fleetHealthReport(selected, skipped, deps.clientFor, concurrency)
      : kind === 'fleet_updates_report'
        ? await fleetUpdatesReport(selected, skipped, deps.clientFor, concurrency, true)
        : await fleetSiteHealthReport(selected, skipped, deps.clientFor, concurrency, { includeSizes: true });
  const stored = storeIngest(deps.db, { kind, collectedAt, data: report }, new Set(all.map((s) => s.id)));
  const failed = report.results.filter((r) => !r.ok || (kind === 'fleet_health' && (r.data as { ok?: boolean } | undefined)?.ok !== true)).length;
  return { kind, sites: report.results.length, failed, skipped: report.summary.skipped, stored };
}

const defaultLog = (m: string): void => {
  process.stderr.write(`[wp-dashboard] ${m}\n`);
};

/**
 * One scheduler tick: health, then updates, then Site Health, each only when due (unless
 * `force`). Sequential on purpose, to keep the load on the sites low. Never rejects.
 */
export async function runSyncCycle(deps: SyncDeps, schedule: SyncSchedule, opts: { force?: boolean } = {}): Promise<SyncTaskResult[]> {
  const log = deps.log ?? defaultLog;
  const plan: Array<[SyncKind, number]> = [
    ['fleet_health', schedule.healthIntervalMs],
    ['fleet_updates_report', schedule.updatesIntervalMs],
    [HEALTH_KIND, schedule.updatesIntervalMs],
  ];
  const results: SyncTaskResult[] = [];
  for (const [kind, intervalMs] of plan) {
    if (!opts.force && !isSyncDue(deps.db, kind, intervalMs, deps.now?.() ?? new Date())) continue;
    try {
      const result = await runSyncTask(kind, deps);
      results.push(result);
      log(`sync ${kind}: ${result.sites} site(s), ${result.failed} failed, ${result.skipped} skipped`);
    } catch (err) {
      log(`sync ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return results;
}

/** First tick shortly after boot (only runs what is due), then every shortest interval. Timers never keep the process alive. */
export function startSyncScheduler(deps: SyncDeps, schedule: SyncSchedule): void {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void runSyncCycle(deps, schedule).finally(() => {
      running = false;
    });
  };
  setTimeout(tick, START_DELAY_MS).unref();
  setInterval(tick, Math.min(schedule.healthIntervalMs, schedule.updatesIntervalMs)).unref();
}
