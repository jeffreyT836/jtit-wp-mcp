import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveSite } from '../config/loader.js';
import {
  siteConfigSchema,
  siteIdSchema,
  type ResolvedSite,
  type SiteConfig,
  type SiteConfigInput,
} from '../config/schema.js';
import { decryptSecret, encryptSecret, SecretCryptoError } from './crypto.js';

const DEFAULT_CONTAINER_DIR = '/app/data';
const DEFAULT_LOCAL_PATH = './data/sites.db';
const KEY_VERSION = 1;
const SCHEMA_VERSION = 2;

/** Resolves the store path: `SITES_DB`, else `/app/data/sites.db` in the container, else `./data/sites.db`. */
export function resolveSitesDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SITES_DB) return env.SITES_DB;
  if (existsSync(DEFAULT_CONTAINER_DIR)) return `${DEFAULT_CONTAINER_DIR}/sites.db`;
  return DEFAULT_LOCAL_PATH;
}

/** Thrown for invalid input to a store mutation (bad site config, unknown id). */
export class SiteStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteStoreError';
  }
}

/** A stored site without its secret — safe to print or return from an API. */
export interface StoredSite extends SiteConfig {
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SiteRow {
  id: string;
  name: string;
  url: string;
  username: string;
  tags: string;
  read_only: number;
  allow_http: number;
  bridge: number;
  health_paths: string;
  secret: string | null;
  created_at: string;
  updated_at: string;
}

function rowToConfig(row: SiteRow): SiteConfig {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    username: row.username,
    tags: JSON.parse(row.tags) as string[],
    readOnly: row.read_only === 1,
    allowHttp: row.allow_http === 1,
    bridge: row.bridge === 1,
    healthPaths: JSON.parse(row.health_paths ?? '[]') as string[],
  };
}

/**
 * SQLite-backed site store. Application passwords are stored AES-256-GCM encrypted (site id
 * as AAD); everything else is plain. Every mutation bumps a `version` counter so readers in
 * another process (the MCP server, while the CLI or dashboard writes) can cheaply detect
 * changes via {@link version} and reload with {@link load}.
 */
export class SiteStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly key: Buffer,
  ) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const version = () =>
      (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version() >= SCHEMA_VERSION) return;
    // The MCP and dashboard containers open the same file at the same time after a
    // deploy: migrate under a write lock and re-read the version once we hold it.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.migrateLocked(version());
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private migrateLocked(current: number): void {
    if (current < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sites (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          username TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          read_only INTEGER NOT NULL DEFAULT 0,
          allow_http INTEGER NOT NULL DEFAULT 0,
          bridge INTEGER NOT NULL DEFAULT 1,
          secret TEXT,
          key_version INTEGER NOT NULL DEFAULT ${KEY_VERSION},
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT OR IGNORE INTO meta (key, value) VALUES ('version', 0);
      `);
    }
    if (current < 2) {
      // v2: extra pages checked after safe updates.
      this.db.exec(`ALTER TABLE sites ADD COLUMN health_paths TEXT NOT NULL DEFAULT '[]'`);
    }
    if (current < SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  /** Monotonic counter, bumped by every mutation. */
  version(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
      | { value: number }
      | undefined;
    return row?.value ?? 0;
  }

  private rows(): SiteRow[] {
    return this.db
      .prepare('SELECT * FROM sites ORDER BY created_at, rowid')
      .all() as unknown as SiteRow[];
  }

  /** All sites without secrets. */
  list(): StoredSite[] {
    return this.rows().map((row) => ({
      ...rowToConfig(row),
      hasPassword: row.secret !== null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * All sites with decrypted secrets, for the MCP registry. A secret that fails to decrypt
   * marks only that site unavailable instead of failing the whole load.
   */
  load(): ResolvedSite[] {
    return this.rows().map((row) => {
      const config = rowToConfig(row);
      if (row.secret === null) return resolveSite(config, null);
      try {
        return resolveSite(config, decryptSecret(row.secret, this.key, row.id));
      } catch (err) {
        const reason = err instanceof SecretCryptoError ? err.message : 'secret could not be decrypted';
        return resolveSite(config, null, reason);
      }
    });
  }

  /**
   * Inserts or updates a site. `password` undefined keeps an existing secret; null clears it.
   * Returns the stored site (without secret).
   */
  upsert(input: SiteConfigInput, password?: string | null): StoredSite {
    const parsed = siteConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new SiteStoreError(
        `invalid site: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    const site = parsed.data;
    if (typeof password === 'string' && password.trim() === '') {
      throw new SiteStoreError('application password must not be empty');
    }
    const now = new Date().toISOString();
    const secret =
      typeof password === 'string' ? encryptSecret(password.trim(), this.key, site.id) : null;

    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sites (id, name, url, username, tags, read_only, allow_http, bridge, health_paths, secret, key_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, url = excluded.url, username = excluded.username,
             tags = excluded.tags, read_only = excluded.read_only,
             allow_http = excluded.allow_http, bridge = excluded.bridge,
             health_paths = excluded.health_paths,
             secret = CASE WHEN ? THEN excluded.secret ELSE sites.secret END,
             key_version = excluded.key_version, updated_at = excluded.updated_at`,
        )
        .run(
          site.id,
          site.name,
          site.url,
          site.username,
          JSON.stringify(site.tags),
          site.readOnly ? 1 : 0,
          site.allowHttp ? 1 : 0,
          site.bridge ? 1 : 0,
          JSON.stringify(site.healthPaths),
          secret,
          KEY_VERSION,
          now,
          now,
          password === undefined ? 0 : 1,
        );
    });
    const stored = this.list().find((s) => s.id === site.id);
    if (!stored) throw new SiteStoreError(`site "${site.id}" was not stored`);
    return stored;
  }

  /** Deletes a site; returns false when it did not exist. */
  remove(id: string): boolean {
    if (!siteIdSchema.safeParse(id).success) return false;
    let changes = 0;
    this.transaction(() => {
      changes = Number(this.db.prepare('DELETE FROM sites WHERE id = ?').run(id).changes);
    });
    return changes > 0;
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` and bumps the version in one transaction. */
  private transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec("UPDATE meta SET value = value + 1 WHERE key = 'version'");
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
