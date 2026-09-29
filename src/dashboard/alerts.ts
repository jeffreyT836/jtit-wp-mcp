import type { StoredSite } from '../store/site-store.js';
import { versionCompare, worstSeverity, type SiteVulnerabilityReport } from '../wp/vulnerabilities.js';
import type { AlertRow, AlertSeverity, DashboardDb, SnapshotRow } from './db.js';

/**
 * Alerts: conditions derived from the snapshots n8n (or the dashboard itself) stores.
 *
 * Each rule turns the newest snapshot of one (site, kind) into the set of conditions that
 * hold now. A "state" condition opens an alert when it appears and resolves it once the
 * condition is gone; an "event" condition (e.g. a new administrator) stays open until
 * someone acknowledges it. Only transitions (opened / resolved) are notified.
 */

export type AlertType =
  | 'unreachable'
  | 'not_admin'
  | 'bridge_problem'
  | 'health_critical'
  | 'vulnerable'
  | 'new_admin'
  | 'stale_data';

export interface Condition {
  key: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  details?: Record<string, unknown>;
  stateKind: 'state' | 'event';
  /** Consecutive evaluations the condition must hold before the alert opens (default 1). */
  confirm?: number;
}

export interface Evaluation {
  source: string;
  siteId: string | null;
  /**
   * Alert types this evaluation had the data to judge. Open state alerts of these types
   * that are not among `conditions` are resolved; other types are left untouched (e.g.
   * "bridge_problem" while the site is unreachable).
   */
  evaluated: AlertType[];
  conditions: Condition[];
}

export interface AlertChange {
  change: 'opened' | 'resolved';
  alert: AlertRow;
}

export const SYSTEM_SOURCE = 'system';
/** An unreachable site must fail two checks in a row (n8n already retries once per run). */
const UNREACHABLE_CONFIRMATIONS = 2;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const stripTags = (v: string): string => v.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function parse(row: SnapshotRow | undefined): Json | undefined {
  if (!row) return undefined;
  try {
    return obj(JSON.parse(row.data));
  } catch {
    return undefined;
  }
}

function healthRule(siteId: string, site: StoredSite | undefined, parsed: Json): Evaluation {
  const data = obj(parsed.data);
  if (parsed.ok !== true || data?.ok !== true) {
    const error = str(data?.error) ?? str(parsed.error) ?? 'onbekende fout';
    return {
      source: 'fleet_health',
      siteId,
      evaluated: ['unreachable'],
      conditions: [{
        key: `unreachable:${siteId}`,
        type: 'unreachable',
        severity: 'critical',
        title: 'Site niet bereikbaar of inloggen mislukt',
        details: { error: stripTags(error) },
        stateKind: 'state',
        confirm: UNREACHABLE_CONFIRMATIONS,
      }],
    };
  }
  const conditions: Condition[] = [];
  const roles = Array.isArray(data.roles) ? (data.roles as unknown[]) : [];
  if (!roles.includes('administrator')) {
    conditions.push({
      key: `not_admin:${siteId}`,
      type: 'not_admin',
      severity: 'warning',
      title: 'Koppel-gebruiker is geen administrator meer',
      details: { roles },
      stateKind: 'state',
    });
  }
  const bridge = str(data.bridge);
  if (site?.bridge !== false && (bridge === 'missing' || bridge === 'error')) {
    conditions.push({
      key: `bridge_problem:${siteId}`,
      type: 'bridge_problem',
      severity: 'warning',
      title: bridge === 'missing' ? 'nb-mcp-bridge ontbreekt op de site' : 'nb-mcp-bridge geeft een fout',
      details: { bridge },
      stateKind: 'state',
    });
  }
  return { source: 'fleet_health', siteId, evaluated: ['unreachable', 'not_admin', 'bridge_problem'], conditions };
}

function siteHealthRule(siteId: string, parsed: Json): Evaluation | null {
  const data = obj(parsed.data);
  if (parsed.ok !== true || !Array.isArray(data?.tests)) return null;
  const conditions = (data.tests as unknown[])
    .map(obj)
    .filter((t): t is Json => t?.status === 'critical' && typeof t.test === 'string')
    .map((t): Condition => ({
      key: `health_critical:${siteId}:${String(t.test)}`,
      type: 'health_critical',
      severity: 'warning',
      title: `Site Health kritiek: ${stripTags(str(t.label) ?? String(t.test))}`,
      details: { test: t.test },
      stateKind: 'state',
    }));
  return { source: 'fleet_site_health', siteId, evaluated: ['health_critical'], conditions };
}

const COMPONENT_LABEL = { core: 'WordPress-core', plugin: 'plugin', theme: 'thema' } as const;

function vulnerabilityRule(siteId: string, parsed: Json): Evaluation | null {
  const report = obj(parsed.data) as SiteVulnerabilityReport | undefined;
  if (parsed.ok !== true || !report || !Array.isArray(report.findings)) return null;
  const conditions: Condition[] = [];
  for (const finding of report.findings) {
    const vulns = Array.isArray(finding.vulnerabilities) ? finding.vulnerabilities : [];
    // Low and unknown severities stay visible in the dashboard but do not alert.
    const relevant = vulns.filter((v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium');
    if (relevant.length === 0) continue;
    const worst = worstSeverity(relevant);
    const fixes = relevant.map((v) => v.fixedIn).filter((v): v is string => !!v);
    const label = COMPONENT_LABEL[finding.type] ?? finding.type;
    conditions.push({
      key: `vulnerable:${siteId}:${finding.type}:${finding.slug}`,
      type: 'vulnerable',
      severity: worst === 'medium' ? 'warning' : 'critical',
      title: `Kwetsbare ${label}: ${finding.name ?? finding.slug} ${finding.version}`,
      details: {
        component: finding.type,
        slug: finding.slug,
        version: finding.version,
        worst,
        count: relevant.length,
        unfixed: relevant.some((v) => v.unfixed),
        fixedIn: fixes.length ? fixes.reduce((a, b) => (versionCompare(a, b) >= 0 ? a : b)) : undefined,
        vulnerabilities: relevant.slice(0, 5).map((v) => v.name),
      },
      stateKind: 'state',
    });
  }
  // A failed lookup means "unknown", so nothing is resolved on an incomplete scan.
  const complete = !Array.isArray(report.errors) || report.errors.length === 0;
  return { source: 'fleet_vulnerabilities', siteId, evaluated: complete ? ['vulnerable'] : [], conditions };
}

function admins(parsed: Json | undefined): Array<{ username: string; email?: string }> | undefined {
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.users)) return undefined;
  return (parsed.users as unknown[])
    .map(obj)
    .filter((u): u is Json => !!u && typeof u.username === 'string' && Array.isArray(u.roles) && (u.roles as unknown[]).includes('administrator'))
    .map((u) => ({ username: String(u.username), email: str(u.email) }));
}

function newAdminRule(siteId: string, parsed: Json, previous: Json | undefined): Evaluation | null {
  const now = admins(parsed);
  const before = admins(previous);
  // The first audit (or one after a failed/other-role audit) is the baseline, not news.
  if (!now || !before || before.length === 0) return null;
  const known = new Set(before.map((u) => u.username.toLowerCase()));
  const conditions = now
    .filter((u) => !known.has(u.username.toLowerCase()))
    .map((u): Condition => ({
      key: `new_admin:${siteId}:${u.username.toLowerCase()}`,
      type: 'new_admin',
      severity: 'critical',
      title: `Nieuw administrator-account: ${u.username}`,
      details: { username: u.username, email: u.email },
      stateKind: 'event',
    }));
  return { source: 'fleet_user_audit', siteId, evaluated: [], conditions };
}

/** Runs the rule for a snapshot kind on the newest (and previous) snapshot of one site. */
export function evaluateSnapshot(kind: string, siteId: string, site: StoredSite | undefined, latest: SnapshotRow, previous?: SnapshotRow): Evaluation | null {
  const parsed = parse(latest);
  if (!parsed) return null;
  switch (kind) {
    case 'fleet_health':
      return healthRule(siteId, site, parsed);
    case 'fleet_site_health':
      return siteHealthRule(siteId, parsed);
    case 'fleet_vulnerabilities':
      return vulnerabilityRule(siteId, parsed);
    case 'fleet_user_audit':
      return newAdminRule(siteId, parsed, parse(previous));
    default:
      return null;
  }
}

/** Reconciles one evaluation with the stored alerts; returns the transitions. */
export function applyEvaluation(db: DashboardDb, ev: Evaluation, now = new Date().toISOString()): AlertChange[] {
  const changes: AlertChange[] = [];
  const active = db.activeAlerts({ siteId: ev.siteId, source: ev.source });
  const byKey = new Map(active.map((a) => [a.key, a]));
  const seen = new Set<string>();

  for (const cond of ev.conditions) {
    if (seen.has(cond.key)) continue;
    seen.add(cond.key);
    const details = cond.details ? JSON.stringify(cond.details) : null;
    const confirm = cond.confirm ?? 1;
    const existing = byKey.get(cond.key);
    if (existing) {
      const hits = existing.hits + 1;
      const opens = existing.status === 'pending' && hits >= confirm;
      db.updateAlert(existing.id, {
        hits,
        last_seen: now,
        severity: cond.severity,
        title: cond.title,
        details,
        ...(opens ? { status: 'open' as const, opened_at: now } : {}),
      });
      if (opens) changes.push({ change: 'opened', alert: db.alertById(existing.id)! });
      continue;
    }
    const opens = confirm <= 1;
    const alert = db.insertAlert({
      key: cond.key,
      site_id: ev.siteId,
      type: cond.type,
      source: ev.source,
      severity: cond.severity,
      title: cond.title,
      details,
      state_kind: cond.stateKind,
      status: opens ? 'open' : 'pending',
      hits: 1,
      first_seen: now,
      last_seen: now,
      opened_at: opens ? now : null,
    });
    if (opens) changes.push({ change: 'opened', alert });
  }

  for (const alert of active) {
    if (seen.has(alert.key) || alert.state_kind === 'event' || !ev.evaluated.includes(alert.type as AlertType)) continue;
    if (alert.status === 'pending') {
      db.deleteAlert(alert.id);
      continue;
    }
    db.updateAlert(alert.id, { status: 'resolved', resolved_at: now });
    changes.push({ change: 'resolved', alert: db.alertById(alert.id)! });
  }
  return changes;
}

/** Evaluates the newest snapshot of `kind` for each given site (after an ingest or refresh). */
export function evaluateSites(db: DashboardDb, sites: StoredSite[], kind: string, siteIds: string[]): AlertChange[] {
  const changes: AlertChange[] = [];
  for (const siteId of new Set(siteIds)) {
    const [latest, previous] = db.recentSnapshots(siteId, kind, 2);
    if (!latest) continue;
    const ev = evaluateSnapshot(kind, siteId, sites.find((s) => s.id === siteId), latest, previous);
    if (ev) changes.push(...applyEvaluation(db, ev));
  }
  return changes;
}

/** Fleet-wide alert when n8n has not delivered anything for `maxAgeHours`. */
export function evaluateStaleData(db: DashboardDb, maxAgeHours: number, now = Date.now()): AlertChange[] {
  const last = db.lastSnapshotReceivedAt();
  if (!last) return []; // nothing ever received: a fresh install, not an outage
  const ageMs = now - new Date(last).getTime();
  const stale = ageMs > maxAgeHours * 3_600_000;
  return applyEvaluation(db, {
    source: SYSTEM_SOURCE,
    siteId: null,
    evaluated: ['stale_data'],
    conditions: stale
      ? [{
          key: 'stale_data',
          type: 'stale_data',
          severity: 'warning',
          title: `Al ${Math.floor(ageMs / 3_600_000)} uur geen data van n8n ontvangen`,
          details: { lastReceivedAt: last },
          stateKind: 'state',
        }]
      : [],
  }, new Date(now).toISOString());
}

/**
 * Acknowledges an alert. An event alert is closed by it; a state alert stays visible
 * (muted) until its condition is gone.
 */
export function acknowledgeAlert(db: DashboardDb, id: number, actor: string): AlertRow | undefined {
  const alert = db.alertById(id);
  if (!alert || (alert.status !== 'open' && alert.status !== 'acknowledged')) return undefined;
  const now = new Date().toISOString();
  db.updateAlert(id, {
    acknowledged_at: now,
    acknowledged_by: actor,
    ...(alert.state_kind === 'event' ? { status: 'resolved' as const, resolved_at: now } : { status: 'acknowledged' as const }),
  });
  return db.alertById(id);
}
