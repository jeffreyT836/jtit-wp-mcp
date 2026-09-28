import { dashboardEnvSchema } from '../config/schema.js';
import { parseEncryptionKey } from '../store/crypto.js';
import { resolveSitesDbPath, SiteStore } from '../store/site-store.js';
import { deriveTotpKey } from './auth/totp.js';
import { ABSOLUTE_TTL_MS, IDLE_TTL_MS } from './auth/session.js';
import { createDashboardApp } from './app.js';
import { DashboardDb, resolveDashboardDbPath } from './db.js';
import { SNAPSHOT_RETENTION_DAYS } from './snapshots.js';

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
  const db = new DashboardDb(resolveDashboardDbPath(process.env));
  const app = createDashboardApp({ db, store, env, totpKey: deriveTotpKey(masterKey) });

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
