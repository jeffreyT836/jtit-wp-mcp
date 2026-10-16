import type { ResolvedSite } from '../config/schema.js';
import type { DashboardDb } from '../dashboard/db.js';
import type { SiteStore } from '../store/site-store.js';
import { runFleet } from '../tools/helpers.js';
import type { WpClient } from '../wp/client.js';
import { scanSite } from './scan.js';
import type { WordfenceFeed } from './wordfence.js';

export const SCAN_CONCURRENCY = 3;
const START_DELAY_MS = 30_000;

export interface VulnCycleDeps {
  db: DashboardDb;
  store: SiteStore;
  feed: WordfenceFeed;
  clientFor: (site: ResolvedSite) => WpClient;
  concurrency?: number;
}

/** One scheduled run: refresh the feed when due, then scan every site that has a password. */
export async function runVulnerabilityCycle(deps: VulnCycleDeps): Promise<{ scanned: number; failed: number }> {
  if (!deps.feed.enabled) return { scanned: 0, failed: 0 };
  await deps.feed.refreshIfDue();
  if (!deps.feed.hasData()) return { scanned: 0, failed: 0 };
  const sites = deps.store.load().filter((s) => s.available);
  const results = await runFleet(
    sites,
    async (site) => {
      const outcome = await scanSite(deps.clientFor(site), site.id, { db: deps.db, feed: deps.feed });
      if (!outcome.ok) throw new Error(outcome.error);
    },
    deps.concurrency ?? SCAN_CONCURRENCY,
  );
  return { scanned: results.length, failed: results.filter((r) => !r.ok).length };
}

/** Runs the cycle shortly after start and then every `intervalHours`. Timers never keep the process alive. */
export function startVulnerabilityScheduler(deps: VulnCycleDeps, intervalHours: number): void {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    runVulnerabilityCycle(deps)
      .then(({ scanned, failed }) => {
        if (scanned > 0) process.stderr.write(`[wp-dashboard] vulnerability scan: ${scanned} site(s), ${failed} failed\n`);
      })
      .catch((err: unknown) => {
        process.stderr.write(`[wp-dashboard] vulnerability scan crashed: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => {
        running = false;
      });
  };
  setTimeout(tick, START_DELAY_MS).unref();
  setInterval(tick, intervalHours * 3_600_000).unref();
}
