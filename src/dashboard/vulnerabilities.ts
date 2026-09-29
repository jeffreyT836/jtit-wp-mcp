import { versionCompare, type ComponentFinding, type SiteVulnerabilityReport } from '../wp/vulnerabilities.js';
import type { BridgeUpdates } from '../wp/updates.js';
import { stripPhp } from '../wp/updates.js';
import type { SnapshotRow } from './db.js';
import { plainText } from './updates.js';

/** Snapshot kind shared by n8n (`fleet_vulnerabilities`) and the dashboard's own scan. */
export const VULN_KIND = 'fleet_vulnerabilities';

export interface VulnerabilitySnapshot {
  collectedAt: string;
  data?: SiteVulnerabilityReport;
  error?: string;
}

/** The site's newest vulnerability snapshot, in the per-site `{ site, ok, data }` shape. */
export function latestVulnerabilities(snapshots: SnapshotRow[]): VulnerabilitySnapshot | undefined {
  const row = snapshots.find((s) => s.kind === VULN_KIND);
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.data) as { ok?: boolean; data?: SiteVulnerabilityReport; error?: string };
    if (parsed.ok !== true || !parsed.data || !Array.isArray(parsed.data.findings)) {
      return { collectedAt: row.collected_at, error: plainText(parsed.error ?? 'scan mislukt') };
    }
    return { collectedAt: row.collected_at, data: parsed.data };
  } catch {
    return { collectedAt: row.collected_at, error: 'ongeldige data' };
  }
}

export function vulnerabilitySnapshotPayload(siteId: string, outcome: { data: SiteVulnerabilityReport } | { error: string }): string {
  return JSON.stringify('data' in outcome ? { site: siteId, ok: true, data: outcome.data } : { site: siteId, ok: false, error: outcome.error });
}

export interface FixHint {
  /** Version an available update would install. */
  updateTo: string;
  /** Whether that update fixes every vulnerability with a known fixed version. */
  fixesAll: boolean;
}

/**
 * Matches a finding with the site's pending updates (from `fleet_updates_report`): is there
 * an update, and does it reach the version(s) that fix the vulnerabilities?
 */
export function fixHint(finding: ComponentFinding, updates?: BridgeUpdates): FixHint | undefined {
  if (!updates) return undefined;
  let updateTo: string | undefined;
  if (finding.type === 'plugin') {
    updateTo = updates.plugins?.find((p) => stripPhp(p.plugin).split('/')[0]?.toLowerCase() === finding.slug)?.new_version;
  } else if (finding.type === 'theme') {
    updateTo = updates.themes?.find((t) => t.stylesheet.toLowerCase() === finding.slug)?.new_version;
  } else {
    updateTo = updates.core?.filter((c) => c.response === 'upgrade' && c.version).map((c) => c.version!).sort(versionCompare).at(-1);
  }
  if (!updateTo) return undefined;
  const fixesAll = finding.vulnerabilities.every((v) => !v.unfixed && !!v.fixedIn && versionCompare(updateTo!, v.fixedIn) >= 0);
  return { updateTo, fixesAll };
}
