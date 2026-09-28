import { BridgeFeatureMissingError, type SiteHealth } from '../wp/site-health.js';
import type { SnapshotRow } from './db.js';
import { plainText, updateErrorMessage } from './updates.js';

/** Snapshot kind shared by n8n (`fleet_site_health`) and the dashboard's own refresh. */
export const HEALTH_KIND = 'fleet_site_health';

export interface HealthSnapshot {
  collectedAt: string;
  data?: SiteHealth;
  error?: string;
}

/** The site's newest Site Health snapshot, in the per-site `{ site, ok, data }` shape. */
export function latestHealth(snapshots: SnapshotRow[]): HealthSnapshot | undefined {
  const row = snapshots.find((s) => s.kind === HEALTH_KIND);
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.data) as { ok?: boolean; data?: SiteHealth; error?: string };
    if (parsed.ok !== true || !parsed.data || !Array.isArray(parsed.data.tests)) {
      return { collectedAt: row.collected_at, error: plainText(parsed.error ?? 'Site Health ophalen mislukt') };
    }
    return { collectedAt: row.collected_at, data: parsed.data };
  } catch {
    return { collectedAt: row.collected_at, error: 'ongeldige data' };
  }
}

export function healthSnapshotPayload(siteId: string, outcome: { data: SiteHealth } | { error: string }): string {
  return JSON.stringify('data' in outcome ? { site: siteId, ok: true, data: outcome.data } : { site: siteId, ok: false, error: outcome.error });
}

/** User-facing message for bridge features that need a newer bridge, else the usual mapping. */
export function bridgeErrorMessage(err: unknown): string {
  if (err instanceof BridgeFeatureMissingError) {
    return `De nb-mcp-bridge op deze site (versie ${err.version ?? 'onbekend'}) is te oud hiervoor. Werk hem bij naar 1.2.0.`;
  }
  return updateErrorMessage(err);
}
