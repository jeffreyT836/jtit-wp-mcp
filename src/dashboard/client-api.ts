import type { StoredSite } from '../store/site-store.js';
import { isCriticalVuln, latestVulnerabilities, type VulnItem } from '../vuln/items.js';
import { pluginSlug } from '../vuln/scan.js';
import type { VulnerabilityFeedStatus } from '../vuln/wordfence.js';
import type { SnapshotRow } from './db.js';
import { summarizeSite, type SiteStatus } from './snapshots.js';
import { latestUpdates } from './updates.js';

/**
 * Read-only views for the WP Fleet client API v1 (docs/CLIENT-API.md). Pure functions: all
 * input comes from the site store, the latest snapshots and the feed status.
 */

export const CLIENT_API_VERSION = 1;
/** Data older than this is reported as `stale`. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export type SiteState = 'ok' | 'warning' | 'critical' | 'unknown';
export type IssueSeverity = 'critical' | 'warning' | 'info';
export type IssueCode =
  | 'no-password' | 'unreachable' | 'vulnerability' | 'core-update' | 'updates' | 'health-critical' | 'stale' | 'check-failed';

export interface ClientIssue {
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
}

export interface ClientStatus {
  collectedAt: string | null;
  reachable: boolean | null;
  isAdmin: boolean | null;
  bridge: string | null;
  wpVersion: string | null;
  phpVersion: string | null;
  error: string | null;
  updates: { core: number; plugins: number; themes: number } | null;
  updatesError: string | null;
  health: { critical: number; recommended: number; good: number } | null;
  healthError: string | null;
}

export interface ClientUpdates {
  checkedAt: string;
  core: Array<{ current: string | null; version: string | null; type: 'minor' | 'major' | null }>;
  plugins: Array<{ slug: string; name: string; currentVersion: string | null; newVersion: string | null }>;
  themes: Array<{ slug: string; name: string; currentVersion: string | null; newVersion: string | null }>;
}

export interface ClientVulnerabilities {
  scannedAt: string;
  error: string | null;
  items: VulnItem[];
}

export interface ClientSiteView {
  id: string;
  name: string;
  url: string;
  tags: string[];
  hasPassword: boolean;
  multisite: boolean;
  state: SiteState;
  issues: ClientIssue[];
  status: ClientStatus;
  updates: ClientUpdates | null;
  vulnerabilities: ClientVulnerabilities | null;
}

export interface ClientFleetSummary {
  sites: number;
  ok: number;
  warning: number;
  critical: number;
  unknown: number;
  pendingUpdates: number;
  vulnerabilities: number;
  criticalVulnerabilities: number;
}

export interface ClientFleetView {
  apiVersion: number;
  generatedAt: string;
  vulnerabilityFeed: VulnerabilityFeedStatus;
  summary: ClientFleetSummary;
  sites: ClientSiteView[];
}

const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

function clientStatus(s: SiteStatus): ClientStatus {
  return {
    collectedAt: orNull(s.collectedAt),
    reachable: orNull(s.reachable),
    isAdmin: orNull(s.isAdmin),
    bridge: orNull(s.bridge),
    wpVersion: orNull(s.wpVersion),
    phpVersion: orNull(s.phpVersion),
    error: orNull(s.error),
    updates: s.updates ? { ...s.updates } : null,
    updatesError: orNull(s.updatesError),
    health: s.health ? { ...s.health } : null,
    healthError: orNull(s.healthError),
  };
}

function clientUpdates(snapshots: SnapshotRow[]): ClientUpdates | null {
  const snapshot = latestUpdates(snapshots);
  if (!snapshot) return null;
  const data = snapshot.data;
  return {
    checkedAt: snapshot.collectedAt,
    core: (data?.core ?? [])
      .filter((c) => c.response === 'upgrade')
      .map((c) => ({ current: orNull(c.current), version: orNull(c.version), type: orNull(c.type) })),
    plugins: (data?.plugins ?? []).map((p) => ({
      slug: pluginSlug(p.plugin),
      name: p.name ?? pluginSlug(p.plugin),
      currentVersion: orNull(p.current_version),
      newVersion: orNull(p.new_version),
    })),
    themes: (data?.themes ?? []).map((t) => ({
      slug: t.stylesheet,
      name: t.name ?? t.stylesheet,
      currentVersion: orNull(t.current_version),
      newVersion: orNull(t.new_version),
    })),
  };
}

function clientVulnerabilities(snapshots: SnapshotRow[]): ClientVulnerabilities | null {
  const snapshot = latestVulnerabilities(snapshots);
  if (!snapshot) return null;
  return {
    scannedAt: snapshot.data && !snapshot.error ? snapshot.data.scannedAt : snapshot.collectedAt,
    error: orNull(snapshot.error),
    items: snapshot.data?.items ?? [],
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function vulnMessage(item: VulnItem): string {
  const cvss = item.cvssScore !== null
    ? ` (CVSS ${item.cvssScore.toFixed(1)}${item.cvssRating ? `, ${item.cvssRating}` : ''})`
    : item.cvssRating ? ` (${item.cvssRating})` : '';
  return `${item.softwareName} ${item.installedVersion}: ${item.cve ?? item.title}${cvss}`;
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Issues per the contract's issue table, ordered critical → warning → info. */
export function deriveIssues(
  site: Pick<StoredSite, 'hasPassword'>,
  status: ClientStatus,
  updates: ClientUpdates | null,
  vulnerabilities: ClientVulnerabilities | null,
  now: Date,
): ClientIssue[] {
  const issues: ClientIssue[] = [];
  const add = (severity: IssueSeverity, code: IssueCode, message: string) => issues.push({ severity, code, message });

  if (!site.hasPassword) add('critical', 'no-password', 'Geen Application Password opgeslagen');
  if (status.reachable === false) add('critical', 'unreachable', `Site niet bereikbaar: ${status.error ?? 'onbekende fout'}`);
  for (const item of vulnerabilities?.items ?? []) {
    add(isCriticalVuln(item) ? 'critical' : 'warning', 'vulnerability', vulnMessage(item));
  }
  if (status.updates && status.updates.core > 0) {
    const target = updates?.core[0]?.version;
    add('warning', 'core-update', target ? `WordPress-update beschikbaar: ${target}` : 'WordPress-update beschikbaar');
  }
  if (status.updates && status.updates.plugins + status.updates.themes > 0) {
    const parts = [
      status.updates.plugins > 0 ? plural(status.updates.plugins, 'plugin-update', 'plugin-updates') : null,
      status.updates.themes > 0 ? plural(status.updates.themes, 'thema-update', 'thema-updates') : null,
    ].filter(Boolean);
    add('warning', 'updates', `${parts.join(' en ')} beschikbaar`);
  }
  if (status.health && status.health.critical > 0) {
    add('warning', 'health-critical', `Site Health: ${plural(status.health.critical, 'kritiek probleem', 'kritieke problemen')}`);
  }
  if (!status.collectedAt) {
    add('info', 'stale', 'Nog geen gegevens ontvangen');
  } else if (now.getTime() - Date.parse(status.collectedAt) > STALE_AFTER_MS) {
    add('info', 'stale', `Gegevens zijn verouderd (laatste: ${status.collectedAt})`);
  }
  if (status.updatesError) add('info', 'check-failed', `Update-check mislukt: ${status.updatesError}`);
  if (status.healthError) add('info', 'check-failed', `Site Health-check mislukt: ${status.healthError}`);
  if (vulnerabilities?.error) add('info', 'check-failed', vulnerabilities.error);

  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => SEVERITY_ORDER[a.issue.severity] - SEVERITY_ORDER[b.issue.severity] || a.i - b.i)
    .map(({ issue }) => issue);
}

export function deriveState(issues: ClientIssue[], status: ClientStatus): SiteState {
  if (issues.some((i) => i.severity === 'critical')) return 'critical';
  if (issues.some((i) => i.severity === 'warning')) return 'warning';
  return status.reachable === true ? 'ok' : 'unknown';
}

/** One site as the client API exposes it. `snapshots` = that site's latest snapshots. */
export function buildSiteView(site: StoredSite, snapshots: SnapshotRow[], now: Date): ClientSiteView {
  const summarized = summarizeSite(snapshots);
  const status = clientStatus(summarized);
  const updates = clientUpdates(snapshots);
  const vulnerabilities = clientVulnerabilities(snapshots);
  const issues = deriveIssues(site, status, updates, vulnerabilities, now);
  return {
    id: site.id,
    name: site.name,
    url: site.url,
    tags: [...site.tags],
    hasPassword: site.hasPassword,
    multisite: summarized.multisite === true,
    state: deriveState(issues, status),
    issues,
    status,
    updates,
    vulnerabilities,
  };
}

/** The whole fleet. `snapshots` may contain every site's rows (and fleet-wide ones). */
export function buildFleetView(opts: {
  sites: StoredSite[];
  snapshots: SnapshotRow[];
  feed: VulnerabilityFeedStatus;
  now: Date;
}): ClientFleetView {
  const views = opts.sites.map((site) => buildSiteView(site, opts.snapshots.filter((s) => s.site_id === site.id), opts.now));
  const count = (state: SiteState) => views.filter((v) => v.state === state).length;
  const items = views.flatMap((v) => v.vulnerabilities?.items ?? []);
  return {
    apiVersion: CLIENT_API_VERSION,
    generatedAt: opts.now.toISOString(),
    vulnerabilityFeed: { ...opts.feed },
    summary: {
      sites: views.length,
      ok: count('ok'),
      warning: count('warning'),
      critical: count('critical'),
      unknown: count('unknown'),
      pendingUpdates: views.reduce((sum, v) => sum + (v.status.updates ? v.status.updates.core + v.status.updates.plugins + v.status.updates.themes : 0), 0),
      vulnerabilities: items.length,
      criticalVulnerabilities: items.filter(isCriticalVuln).length,
    },
    sites: views,
  };
}
