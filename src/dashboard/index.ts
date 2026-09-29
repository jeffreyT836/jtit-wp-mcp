import { dashboardEnvSchema } from '../config/schema.js';
import { parseEncryptionKey } from '../store/crypto.js';
import { resolveSitesDbPath, SiteStore } from '../store/site-store.js';
import { deriveTotpKey } from './auth/totp.js';
import { ABSOLUTE_TTL_MS, IDLE_TTL_MS } from './auth/session.js';
import { createDashboardApp } from './app.js';
import { DashboardDb, resolveDashboardDbPath } from './db.js';
import { SNAPSHOT_RETENTION_DAYS } from './snapshots.js';
import { evaluateStaleData } from './alerts.js';
import { AlertNotifier } from './notify.js';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const STALE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const ALERT_RETENTION_DAYS = 90;

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
  const notifier = new AlertNotifier({
    url: env.ALERT_WEBHOOK_URL,
    token: env.ALERT_WEBHOOK_TOKEN,
    publicUrl: env.DASHBOARD_PUBLIC_URL,
    siteName: (id) => store.list().find((s) => s.id === id)?.name,
  });
  const app = createDashboardApp({ db, store, env, totpKey: deriveTotpKey(masterKey), notifier });

  const cleanup = (): void => {
    const now = Date.now();
    db.deleteSessionsBefore(
      new Date(now - ABSOLUTE_TTL_MS).toISOString(),
      new Date(now - IDLE_TTL_MS).toISOString(),
    );
    db.pruneSnapshots(new Date(now - SNAPSHOT_RETENTION_DAYS * 86_400_000).toISOString());
    db.pruneAlerts(new Date(now - ALERT_RETENTION_DAYS * 86_400_000).toISOString());
    db.deleteAlertsOfUnknownSites(store.list().map((s) => s.id));
  };
  cleanup();
  setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

  // "n8n delivers nothing anymore" can only be noticed by the dashboard itself.
  const staleCheck = (): void => {
    notifier.send(evaluateStaleData(db, env.ALERT_STALE_HOURS)).catch(() => undefined);
  };
  setInterval(staleCheck, STALE_CHECK_INTERVAL_MS).unref();

  app.listen(env.DASHBOARD_PORT, env.DASHBOARD_HOST, () => {
    process.stderr.write(`[wp-dashboard] listening on http://${env.DASHBOARD_HOST}:${env.DASHBOARD_PORT}\n`);
  });
}

main();
