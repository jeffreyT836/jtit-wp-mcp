import { z } from 'zod';
import { siteIdSchema } from '../config/schema.js';
import type { SeverityCounts } from '../wp/vulnerabilities.js';
import type { DashboardDb, SnapshotRow } from './db.js';

export const SNAPSHOT_RETENTION_DAYS = 30;

/**
 * Body n8n posts to `/api/ingest`. `data` is typically the parsed JSON text of an MCP tool
 * result (e.g. `fleet_health`). Fleet-shaped data (`{ results: [{ site, ok, data }] }`) is
 * split into one snapshot per site, plus the whole payload as a fleet-wide snapshot.
 */
export const ingestBodySchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'kind must be snake_case'),
  site: siteIdSchema.optional(),
  collectedAt: z.string().datetime({ offset: true }).optional(),
  data: z.unknown().refine((v) => v !== undefined, 'data is required'),
});

export type IngestBody = z.output<typeof ingestBodySchema>;

const fleetResultSchema = z.object({
  results: z.array(z.object({ site: z.string(), ok: z.boolean() }).passthrough()),
});

/** Site ids an ingest payload stores a per-site snapshot for. */
export function ingestedSiteIds(body: IngestBody, knownSiteIds: Set<string>): string[] {
  if (body.site) return [body.site];
  const fleet = fleetResultSchema.safeParse(body.data);
  return fleet.success ? fleet.data.results.map((r) => r.site).filter((id) => knownSiteIds.has(id)) : [];
}

/** Stores an ingest payload; returns how many snapshot rows were written. */
export function storeIngest(db: DashboardDb, body: IngestBody, knownSiteIds: Set<string>): number {
  const collectedAt = new Date(body.collectedAt ?? Date.now()).toISOString();
  if (body.site) {
    db.insertSnapshot(body.site, body.kind, JSON.stringify(body.data), collectedAt);
    return 1;
  }
  let written = 0;
  const fleet = fleetResultSchema.safeParse(body.data);
  if (fleet.success) {
    for (const result of fleet.data.results) {
      if (!knownSiteIds.has(result.site)) continue;
      db.insertSnapshot(result.site, body.kind, JSON.stringify(result), collectedAt);
      written += 1;
    }
  }
  db.insertSnapshot(null, body.kind, JSON.stringify(body.data), collectedAt);
  return written + 1;
}

export interface SiteStatus {
  collectedAt?: string;
  reachable?: boolean;
  isAdmin?: boolean;
  bridge?: string;
  wpVersion?: string;
  phpVersion?: string;
  error?: string;
  updates?: { core: number; plugins: number; themes: number };
  updatesError?: string;
  /** From the bridge status in `fleet_health`. */
  multisite?: boolean;
  health?: { critical: number; recommended: number; good: number };
  healthError?: string;
  /** From `fleet_vulnerabilities`: vulnerabilities (not components) per severity. */
  vulnerabilities?: SeverityCounts;
  vulnerabilitiesError?: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
/** WordPress error messages can contain markup ("<strong>Fout:</strong>"). */
const stripTags = (v: string): string => v.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** Derives a display status from a site's latest `fleet_health` / `fleet_updates_report` snapshots. */
export function summarizeSite(snapshots: SnapshotRow[]): SiteStatus {
  const status: SiteStatus = {};
  const newest = (a?: string, b?: string) => (!a ? b : !b ? a : a > b ? a : b);
  for (const snap of snapshots) {
    let parsed: Json | undefined;
    try {
      parsed = obj(JSON.parse(snap.data));
    } catch {
      continue;
    }
    if (!parsed) continue;
    const data = obj(parsed.data);
    if (snap.kind === 'fleet_health') {
      status.collectedAt = newest(status.collectedAt, snap.collected_at);
      status.reachable = parsed.ok === true && data?.ok === true;
      const roles = Array.isArray(data?.roles) ? (data.roles as unknown[]) : [];
      status.isAdmin = roles.includes('administrator');
      const versions = obj(data?.versions);
      // Prefer the bridge version (tells whether an upgrade is due) over the plain state.
      status.bridge = str(versions?.bridge_version) ?? str(data?.bridge);
      status.wpVersion = str(versions?.wp_version);
      status.phpVersion = str(versions?.php_version);
      if (typeof versions?.multisite === 'boolean') status.multisite = versions.multisite;
      const error = str(data?.error) ?? str(parsed.error);
      status.error = error ? stripTags(error) : undefined;
    } else if (snap.kind === 'fleet_updates_report') {
      status.collectedAt = newest(status.collectedAt, snap.collected_at);
      if (parsed.ok !== true || !data) {
        status.updatesError = stripTags(str(parsed.error) ?? 'onbekende fout');
        continue;
      }
      const core = Array.isArray(data.core)
        ? (data.core as unknown[]).filter((c) => obj(c)?.response === 'upgrade').length
        : 0;
      status.updates = { core, plugins: len(data.plugins), themes: len(data.themes) };
    } else if (snap.kind === 'fleet_site_health') {
      const summary = obj(data?.summary);
      if (parsed.ok !== true || !summary) {
        status.healthError = stripTags(str(parsed.error) ?? 'onbekende fout');
        continue;
      }
      const n = (v: unknown) => (typeof v === 'number' ? v : 0);
      status.health = { critical: n(summary.critical), recommended: n(summary.recommended), good: n(summary.good) };
    } else if (snap.kind === 'fleet_vulnerabilities') {
      const summary = obj(data?.summary);
      if (parsed.ok !== true || !summary) {
        status.vulnerabilitiesError = stripTags(str(parsed.error) ?? 'onbekende fout');
        continue;
      }
      const n = (v: unknown) => (typeof v === 'number' ? v : 0);
      status.vulnerabilities = {
        critical: n(summary.critical), high: n(summary.high), medium: n(summary.medium),
        low: n(summary.low), unknown: n(summary.unknown), total: n(summary.total),
      };
    }
  }
  return status;
}
