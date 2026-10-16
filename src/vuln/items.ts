import type { SnapshotRow } from '../dashboard/db.js';

/** Snapshot kind of a vulnerability scan (per site, `{ site, ok, data | error }`). */
export const VULN_KIND = 'vulnerabilities';

export type SoftwareType = 'core' | 'plugin' | 'theme';

/** One matched vulnerability, exactly as the client API (docs/CLIENT-API.md) exposes it. */
export interface VulnItem {
  id: string;
  title: string;
  softwareType: SoftwareType;
  slug: string;
  softwareName: string;
  installedVersion: string;
  cve: string | null;
  cvssScore: number | null;
  cvssRating: string | null;
  patched: boolean;
  patchedVersions: string[];
  remediation: string | null;
  reference: string | null;
  published: string | null;
}

export interface VulnScanData {
  scannedAt: string;
  items: VulnItem[];
}

export interface VulnSnapshot {
  collectedAt: string;
  /** Items of the last successful scan (also kept when the newest scan failed). */
  data?: VulnScanData;
  error?: string;
}

/** Critical per the contract: CVSS ≥ 7.0, or rated High/Critical. */
export function isCriticalVuln(item: Pick<VulnItem, 'cvssScore' | 'cvssRating'>): boolean {
  if (item.cvssScore !== null && item.cvssScore >= 7) return true;
  const rating = item.cvssRating?.toLowerCase();
  return rating === 'high' || rating === 'critical';
}

/** Stores a scan in the same per-site shape as the other snapshots. A failure keeps the previous items. */
export function vulnSnapshotPayload(
  siteId: string,
  outcome: { data: VulnScanData } | { error: string; previous?: VulnScanData },
): string {
  if ('data' in outcome) return JSON.stringify({ site: siteId, ok: true, data: outcome.data });
  return JSON.stringify({ site: siteId, ok: false, error: outcome.error, ...(outcome.previous ? { data: outcome.previous } : {}) });
}

const isScanData = (v: unknown): v is VulnScanData =>
  !!v && typeof v === 'object' && typeof (v as VulnScanData).scannedAt === 'string' && Array.isArray((v as VulnScanData).items);

/** The site's newest vulnerability scan snapshot. */
export function latestVulnerabilities(snapshots: SnapshotRow[]): VulnSnapshot | undefined {
  const row = snapshots.find((s) => s.kind === VULN_KIND);
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.data) as { ok?: boolean; data?: unknown; error?: string };
    const data = isScanData(parsed.data) ? parsed.data : undefined;
    if (parsed.ok !== true || !data) {
      return { collectedAt: row.collected_at, data, error: parsed.error ?? 'Kwetsbaarhedenscan mislukt' };
    }
    return { collectedAt: row.collected_at, data };
  } catch {
    return { collectedAt: row.collected_at, error: 'ongeldige data' };
  }
}
