import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 2;
const DEFAULT_CONTAINER_DIR = '/app/dashboard-data';
const DEFAULT_LOCAL_PATH = './data/dashboard.db';

/** `DASHBOARD_DB`, else `/app/dashboard-data/dashboard.db` in the container, else `./data/dashboard.db`. */
export function resolveDashboardDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DASHBOARD_DB) return env.DASHBOARD_DB;
  if (existsSync(DEFAULT_CONTAINER_DIR)) return `${DEFAULT_CONTAINER_DIR}/dashboard.db`;
  return DEFAULT_LOCAL_PATH;
}

/** Session progress: password ok → (enrol or verify) TOTP → full access. */
export type SessionStage = 'enroll_totp' | 'verify_totp' | 'full';

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  failed_attempts: number;
  locked_until: string | null;
}

export interface SessionRow {
  id_hash: string;
  user_id: number;
  stage: SessionStage;
  csrf_token: string;
  pending_totp_secret: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface SnapshotRow {
  id: number;
  site_id: string | null;
  kind: string;
  data: string;
  collected_at: string;
  received_at: string;
}

export type AlertStatus = 'pending' | 'open' | 'acknowledged' | 'resolved';
export type AlertSeverity = 'critical' | 'warning';

export interface AlertRow {
  id: number;
  /** Identifies one condition, e.g. "unreachable:klant-a"; unique among non-resolved alerts. */
  key: string;
  site_id: string | null;
  type: string;
  /** Snapshot kind (or "system") whose evaluation raised it. */
  source: string;
  severity: AlertSeverity;
  title: string;
  /** JSON. */
  details: string | null;
  /** "state": resolves itself when the condition is gone; "event": stays until acknowledged. */
  state_kind: 'state' | 'event';
  status: AlertStatus;
  hits: number;
  first_seen: string;
  last_seen: string;
  opened_at: string | null;
  resolved_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  details: string | null;
}

/**
 * The dashboard's own SQLite database (users, sessions, snapshots from n8n, audit log).
 * Sites and their secrets stay in the shared `SiteStore`; nothing here is needed by the MCP.
 */
export class DashboardDb {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    const { user_version: current } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (current >= SCHEMA_VERSION) return;
    if (current < 1) this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        pending_totp_secret TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY,
        site_id TEXT,
        kind TEXT NOT NULL,
        data TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_latest ON snapshots (site_id, kind, collected_at);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        details TEXT
      );
    `);
    if (current < 2) this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL,
        site_id TEXT,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        details TEXT,
        state_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 1,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        opened_at TEXT,
        resolved_at TEXT,
        acknowledged_at TEXT,
        acknowledged_by TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS alerts_active_key ON alerts (key) WHERE status IN ('pending', 'open', 'acknowledged');
      CREATE INDEX IF NOT EXISTS alerts_site ON alerts (site_id, status);
    `);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  // --- users ---

  userByEmail(email: string): UserRow | undefined {
    return this.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email.trim().toLowerCase()) as UserRow | undefined;
  }

  userById(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  /** Creates the user or updates its password hash (idempotent admin seed). */
  upsertUser(email: string, passwordHash: string): { created: boolean } {
    const now = new Date().toISOString();
    const existing = this.userByEmail(email);
    if (existing) {
      this.db
        .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(passwordHash, now, existing.id);
      return { created: false };
    }
    this.db
      .prepare(
        'INSERT INTO users (email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(email.trim().toLowerCase(), passwordHash, now, now);
    return { created: true };
  }

  recordFailedLogin(userId: number, lockUntil: string | null): void {
    this.db
      .prepare(
        'UPDATE users SET failed_attempts = failed_attempts + 1, locked_until = ? WHERE id = ?',
      )
      .run(lockUntil, userId);
  }

  resetFailedLogins(userId: number): void {
    this.db
      .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?')
      .run(userId);
  }

  setTotp(userId: number, encryptedSecret: string | null, enabled: boolean): void {
    this.db
      .prepare('UPDATE users SET totp_secret = ?, totp_enabled = ?, updated_at = ? WHERE id = ?')
      .run(encryptedSecret, enabled ? 1 : 0, new Date().toISOString(), userId);
  }

  // --- sessions ---

  createSession(row: Omit<SessionRow, 'created_at' | 'last_seen_at'>): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id_hash, user_id, stage, csrf_token, pending_totp_secret, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id_hash, row.user_id, row.stage, row.csrf_token, row.pending_totp_secret, now, now);
  }

  session(idHash: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as
      | SessionRow
      | undefined;
  }

  updateSession(
    idHash: string,
    patch: Partial<Pick<SessionRow, 'stage' | 'pending_totp_secret' | 'last_seen_at'>>,
  ): void {
    const current = this.session(idHash);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        'UPDATE sessions SET stage = ?, pending_totp_secret = ?, last_seen_at = ? WHERE id_hash = ?',
      )
      .run(next.stage, next.pending_totp_secret, next.last_seen_at, idHash);
  }

  deleteSession(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  deleteSessionsForUser(userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  deleteSessionsBefore(createdBefore: string, lastSeenBefore: string): void {
    this.db
      .prepare('DELETE FROM sessions WHERE created_at < ? OR last_seen_at < ?')
      .run(createdBefore, lastSeenBefore);
  }

  // --- snapshots ---

  insertSnapshot(siteId: string | null, kind: string, data: string, collectedAt: string): number {
    const result = this.db
      .prepare(
        'INSERT INTO snapshots (site_id, kind, data, collected_at, received_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(siteId, kind, data, collectedAt, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  /** Newest snapshot per (site, kind). `siteId` undefined → all rows, including fleet-wide (null). */
  latestSnapshots(siteId?: string | null): SnapshotRow[] {
    const filter = siteId === undefined ? '' : 'WHERE s.site_id IS ?';
    const sql = `
      SELECT s.* FROM snapshots s
      JOIN (
        SELECT site_id, kind, MAX(collected_at) AS latest FROM snapshots GROUP BY site_id, kind
      ) m ON s.site_id IS m.site_id AND s.kind = m.kind AND s.collected_at = m.latest
      ${filter}
      ORDER BY s.kind`;
    const stmt = this.db.prepare(sql);
    return (siteId === undefined ? stmt.all() : stmt.all(siteId)) as unknown as SnapshotRow[];
  }

  lastSnapshotReceivedAt(): string | undefined {
    const row = this.db.prepare('SELECT MAX(received_at) AS ts FROM snapshots').get() as { ts: string | null };
    return row.ts ?? undefined;
  }

  /** Newest `limit` snapshots of one (site, kind), newest first. */
  recentSnapshots(siteId: string | null, kind: string, limit = 2): SnapshotRow[] {
    return this.db
      .prepare('SELECT * FROM snapshots WHERE site_id IS ? AND kind = ? ORDER BY collected_at DESC, id DESC LIMIT ?')
      .all(siteId, kind, limit) as unknown as SnapshotRow[];
  }

  pruneSnapshots(olderThan: string): void {
    this.db.prepare('DELETE FROM snapshots WHERE received_at < ?').run(olderThan);
  }

  // --- alerts ---

  /** Alerts that are not resolved yet (pending, open, acknowledged). */
  activeAlerts(filter: { siteId?: string | null; source?: string } = {}): AlertRow[] {
    const where = ["status != 'resolved'"];
    const args: Array<string | null> = [];
    if (filter.siteId !== undefined) {
      where.push('site_id IS ?');
      args.push(filter.siteId);
    }
    if (filter.source !== undefined) {
      where.push('source = ?');
      args.push(filter.source);
    }
    return this.db
      .prepare(`SELECT * FROM alerts WHERE ${where.join(' AND ')} ORDER BY id`)
      .all(...args) as unknown as AlertRow[];
  }

  alertById(id: number): AlertRow | undefined {
    return this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as AlertRow | undefined;
  }

  insertAlert(row: Omit<AlertRow, 'id' | 'resolved_at' | 'acknowledged_at' | 'acknowledged_by'>): AlertRow {
    const result = this.db
      .prepare(
        `INSERT INTO alerts (key, site_id, type, source, severity, title, details, state_kind, status, hits, first_seen, last_seen, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.key, row.site_id, row.type, row.source, row.severity, row.title, row.details, row.state_kind, row.status, row.hits, row.first_seen, row.last_seen, row.opened_at);
    return this.alertById(Number(result.lastInsertRowid))!;
  }

  updateAlert(id: number, patch: Partial<Pick<AlertRow, 'severity' | 'title' | 'details' | 'status' | 'hits' | 'last_seen' | 'opened_at' | 'resolved_at' | 'acknowledged_at' | 'acknowledged_by'>>): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length === 0) return;
    this.db
      .prepare(`UPDATE alerts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => patch[k] ?? null), id);
  }

  deleteAlert(id: number): void {
    this.db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
  }

  /** Open and acknowledged alerts, then the latest resolved ones. */
  listAlerts(resolvedLimit = 100): { active: AlertRow[]; resolved: AlertRow[] } {
    const active = this.db
      .prepare("SELECT * FROM alerts WHERE status IN ('open', 'acknowledged') ORDER BY status = 'acknowledged', severity = 'warning', opened_at DESC")
      .all() as unknown as AlertRow[];
    const resolved = this.db
      .prepare("SELECT * FROM alerts WHERE status = 'resolved' AND opened_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ?")
      .all(resolvedLimit) as unknown as AlertRow[];
    return { active, resolved };
  }

  /** Open (not yet acknowledged) alerts, per site id ("" for fleet-wide ones). */
  openAlertCounts(): Map<string, number> {
    const rows = this.db
      .prepare("SELECT site_id, COUNT(*) AS n FROM alerts WHERE status = 'open' GROUP BY site_id")
      .all() as Array<{ site_id: string | null; n: number }>;
    return new Map(rows.map((r) => [r.site_id ?? '', r.n]));
  }

  deleteAlertsForSite(siteId: string): void {
    this.db.prepare('DELETE FROM alerts WHERE site_id = ?').run(siteId);
  }

  /** Drops alerts of sites that no longer exist (e.g. removed via the CLI). */
  deleteAlertsOfUnknownSites(knownSiteIds: string[]): void {
    for (const alert of this.activeAlerts()) {
      if (alert.site_id !== null && !knownSiteIds.includes(alert.site_id)) this.deleteAlert(alert.id);
    }
  }

  pruneAlerts(resolvedBefore: string): void {
    this.db.prepare("DELETE FROM alerts WHERE status = 'resolved' AND resolved_at < ?").run(resolvedBefore);
  }

  // --- audit ---

  audit(actor: string, action: string, target: string | null, details?: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO audit (ts, actor, action, target, details) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), actor, action, target, details ? JSON.stringify(details) : null);
  }

  recentAudit(limit = 200): AuditRow[] {
    return this.db
      .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as AuditRow[];
  }

  close(): void {
    this.db.close();
  }
}
