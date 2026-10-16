import type { DashboardDb } from '../dashboard/db.js';
import { summarizeSite } from '../dashboard/snapshots.js';
import { fetchPlugins } from '../tools/plugins.js';
import { fetchThemes } from '../tools/themes.js';
import type { WpClient } from '../wp/client.js';
import { sanitizeMessage, WpError } from '../wp/errors.js';
import { stripPhp } from '../wp/updates.js';
import { latestVulnerabilities, VULN_KIND, vulnSnapshotPayload, type SoftwareType, type VulnItem, type VulnScanData } from './items.js';
import { inRange } from './version.js';
import type { CompactVuln } from './wordfence.js';

export interface InstalledSoftware {
  type: SoftwareType;
  slug: string;
  name: string;
  version: string;
}

/** What the scan needs from the feed (keeps tests free of the full class). */
export interface VulnLookup {
  lookup(type: SoftwareType, slug: string): CompactVuln[];
}

/** "akismet/akismet.php" → "akismet"; single-file "hello.php" → "hello". */
export const pluginSlug = (plugin: string): string => stripPhp(plugin).split('/')[0] ?? plugin;

/** Non-informational vulnerabilities whose affected ranges include the installed version. */
export function matchVulnerabilities(installed: InstalledSoftware[], feed: VulnLookup): VulnItem[] {
  const items: VulnItem[] = [];
  for (const software of installed) {
    const seen = new Set<string>();
    for (const vuln of feed.lookup(software.type, software.slug)) {
      if (vuln.informational || seen.has(vuln.id)) continue;
      if (!vuln.ranges.some((range) => inRange(software.version, range))) continue;
      seen.add(vuln.id);
      items.push({
        id: vuln.id,
        title: vuln.title,
        softwareType: software.type,
        slug: software.slug,
        softwareName: software.name || vuln.name,
        installedVersion: software.version,
        cve: vuln.cve,
        cvssScore: vuln.cvssScore,
        cvssRating: vuln.cvssRating,
        patched: vuln.patched,
        patchedVersions: vuln.patchedVersions,
        remediation: vuln.remediation,
        reference: vuln.reference,
        published: vuln.published,
      });
    }
  }
  const order: Record<SoftwareType, number> = { core: 0, plugin: 1, theme: 2 };
  return items.sort((a, b) => order[a.softwareType] - order[b.softwareType] || (b.cvssScore ?? 0) - (a.cvssScore ?? 0));
}

/** WordPress version from the bridge, else from the newest `fleet_health` snapshot. */
async function coreVersion(client: WpClient, fallback?: string): Promise<string | undefined> {
  try {
    const status = await client.bridge<{ wp_version?: unknown }>('/status');
    if (typeof status?.wp_version === 'string' && status.wp_version) return status.wp_version;
  } catch {
    // No (or an old) bridge: fall back to the last known version.
  }
  return fallback;
}

/** Installed core, plugins (`/wp/v2/plugins`) and themes (`/wp/v2/themes`) with their versions. */
export async function collectInstalled(client: WpClient, fallbackWpVersion?: string): Promise<InstalledSoftware[]> {
  const [wpVersion, plugins, themes] = await Promise.all([
    coreVersion(client, fallbackWpVersion),
    fetchPlugins(client),
    fetchThemes(client),
  ]);
  const installed: InstalledSoftware[] = [];
  if (wpVersion) installed.push({ type: 'core', slug: 'wordpress', name: 'WordPress', version: wpVersion });
  for (const p of plugins) {
    if (p.version) installed.push({ type: 'plugin', slug: pluginSlug(p.plugin), name: p.name ?? pluginSlug(p.plugin), version: p.version });
  }
  for (const t of themes) {
    if (t.version) installed.push({ type: 'theme', slug: t.stylesheet, name: t.name ?? t.stylesheet, version: t.version });
  }
  return installed;
}

const scanErrorMessage = (err: unknown): string =>
  err instanceof WpError ? `Kwetsbaarhedenscan mislukt: ${err.message}` : `Kwetsbaarhedenscan mislukt: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`;

export type VulnScanOutcome = { ok: true; data: VulnScanData } | { ok: false; error: string };

/**
 * Scans one site against the feed and stores the result as a `vulnerabilities` snapshot.
 * Never throws; a failed scan keeps the previous items next to the error.
 */
export async function scanSite(
  client: WpClient,
  siteId: string,
  deps: { db: DashboardDb; feed: VulnLookup; now?: () => Date },
): Promise<VulnScanOutcome> {
  const scannedAt = (deps.now?.() ?? new Date()).toISOString();
  const snapshots = deps.db.latestSnapshots(siteId);
  try {
    const installed = await collectInstalled(client, summarizeSite(snapshots).wpVersion);
    const data: VulnScanData = { scannedAt, items: matchVulnerabilities(installed, deps.feed) };
    deps.db.insertSnapshot(siteId, VULN_KIND, vulnSnapshotPayload(siteId, { data }), scannedAt);
    return { ok: true, data };
  } catch (err) {
    const error = scanErrorMessage(err);
    const previous = latestVulnerabilities(snapshots)?.data;
    deps.db.insertSnapshot(siteId, VULN_KIND, vulnSnapshotPayload(siteId, { error, previous }), scannedAt);
    return { ok: false, error };
  }
}
