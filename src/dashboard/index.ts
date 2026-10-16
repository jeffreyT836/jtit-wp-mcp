import { dirname, join } from 'node:path';
import { dashboardEnvSchema } from '../config/schema.js';
import { parseEncryptionKey } from '../store/crypto.js';
import { resolveSitesDbPath, SiteStore } from '../store/site-store.js';
import { deriveTotpKey } from './auth/totp.js';
import { ABSOLUTE_TTL_MS, IDLE_TTL_MS } from './auth/session.js';
import { createDashboardApp } from './app.js';
import { DashboardDb, resolveDashboardDbPath } from './db.js';
import { SNAPSHOT_RETENTION_DAYS } from './snapshots.js';
import { WpClient } from '../wp/client.js';
import { startVulnerabilityScheduler } from '../vuln/scheduler.js';
import { WordfenceFeed } from '../vuln/wordfence.js';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function fail(message: string): never {
  process.stderr.write(`[wp-dashboard] fatal: ${message}\n`);
  process.exit(1);
}

function main(): void {
  const parsed = dashboardEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const env = parsed.data;

  let masterKey: Buffer;
  try {
    masterKey = parseEncryptionKey(env.SITES_ENCRYPTION_KEY);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const store = new SiteStore(resolveSitesDbPath(process.env), masterKey);
  const dbPath = resolveDashboardDbPath(process.env);
  const db = new DashboardDb(dbPath);
  const vulnFeed = new WordfenceFeed({
    apiKey: env.WORDFENCE_API_KEY,
    feed: env.WORDFENCE_FEED,
    refreshHours: env.VULN_FEED_REFRESH_HOURS,
    cacheFile: env.VULN_CACHE_FILE ?? join(dirname(dbPath), 'wordfence-index.json'),
  });
  vulnFeed.loadCache();
  const app = createDashboardApp({ db, store, env, totpKey: deriveTotpKey(masterKey), vulnFeed });
  if (vulnFeed.enabled) {
    startVulnerabilityScheduler(
      { db, store, feed: vulnFeed, clientFor: (site) => new WpClient(site, { defaultTimeoutMs: env.WP_TIMEOUT_MS }) },
      env.VULN_SCAN_INTERVAL_HOURS,
    );
  } else {
    process.stderr.write('[wp-dashboard] WORDFENCE_API_KEY not set; vulnerability scanning disabled\n');
  }

  const cleanup = (): void => {
    const now = Date.now();
    db.deleteSessionsBefore(
      new Date(now - ABSOLUTE_TTL_MS).toISOString(),
      new Date(now - IDLE_TTL_MS).toISOString(),
    );
    db.pruneSnapshots(new Date(now - SNAPSHOT_RETENTION_DAYS * 86_400_000).toISOString());
  };
  cleanup();
  setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

  app.listen(env.DASHBOARD_PORT, env.DASHBOARD_HOST, () => {
    process.stderr.write(`[wp-dashboard] listening on http://${env.DASHBOARD_HOST}:${env.DASHBOARD_PORT}\n`);
  });
}

main();
