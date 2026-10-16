import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FetchLike } from '../wp/client.js';
import { sanitizeMessage } from '../wp/errors.js';
import { splitTopLevelRecords } from './feed-parser.js';
import type { SoftwareType } from './items.js';
import type { VersionRange } from './version.js';

export type WordfenceFeedName = 'production' | 'scanner';

const FEED_URL = (feed: WordfenceFeedName) => `https://www.wordfence.com/api/intelligence/v3/vulnerabilities/${feed}`;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
/** After a failed refresh, wait this long before the next attempt (the feed is rate limited). */
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const CACHE_VERSION = 1;

/** One feed record reduced to one affected software entry, with only what the client API needs. */
export interface CompactVuln {
  id: string;
  title: string;
  type: SoftwareType;
  slug: string;
  name: string;
  ranges: VersionRange[];
  patched: boolean;
  patchedVersions: string[];
  remediation: string | null;
  informational: boolean;
  cve: string | null;
  cvssScore: number | null;
  cvssRating: string | null;
  reference: string | null;
  published: string | null;
}

/** `vulnerabilityFeed` in the client API. */
export interface VulnerabilityFeedStatus {
  enabled: boolean;
  source: string;
  updatedAt: string | null;
  records: number | null;
  error: string | null;
}

export interface WordfenceFeedOptions {
  /** Feature is disabled when absent. */
  apiKey?: string;
  feed?: WordfenceFeedName;
  /** Where the compact index is persisted; no persistence when absent. */
  cacheFile?: string;
  refreshHours?: number;
  fetch?: FetchLike;
  now?: () => number;
  log?: (message: string) => void;
}

const SOFTWARE_TYPES = new Set<SoftwareType>(['core', 'plugin', 'theme']);

/** Index key; core is matched by type alone (Wordfence uses slug "wordpress"). */
export const indexKey = (type: SoftwareType, slug: string): string => (type === 'core' ? 'core:wordpress' : `${type}:${slug}`);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function toRanges(affected: unknown): VersionRange[] {
  const ranges: VersionRange[] = [];
  for (const value of Object.values(obj(affected) ?? {})) {
    const r = obj(value);
    if (!r || typeof r.from_version !== 'string' || typeof r.to_version !== 'string') continue;
    ranges.push({
      from_version: r.from_version,
      from_inclusive: r.from_inclusive === true,
      to_version: r.to_version,
      to_inclusive: r.to_inclusive === true,
    });
  }
  return ranges;
}

/** Turns one raw feed record into compact entries, one per affected software. */
export function compactRecord(raw: unknown): CompactVuln[] {
  const record = obj(raw);
  if (!record || typeof record.id !== 'string' || !Array.isArray(record.software)) return [];
  const cvss = obj(record.cvss);
  const references = Array.isArray(record.references) ? record.references : [];
  const shared = {
    id: record.id,
    title: typeof record.title === 'string' ? record.title : record.id,
    informational: record.informational === true,
    cve: strOrNull(record.cve),
    cvssScore: typeof cvss?.score === 'number' ? cvss.score : null,
    cvssRating: strOrNull(cvss?.rating),
    reference: strOrNull(references.find((r) => typeof r === 'string' && /^https?:\/\//i.test(r))),
    published: strOrNull(record.published),
  };
  const entries: CompactVuln[] = [];
  for (const s of record.software) {
    const software = obj(s);
    const type = software?.type as SoftwareType;
    if (!software || !SOFTWARE_TYPES.has(type) || typeof software.slug !== 'string') continue;
    entries.push({
      ...shared,
      type,
      slug: software.slug,
      name: typeof software.name === 'string' ? software.name : software.slug,
      ranges: toRanges(software.affected_versions),
      patched: software.patched === true,
      patchedVersions: Array.isArray(software.patched_versions)
        ? software.patched_versions.filter((v): v is string => typeof v === 'string')
        : [],
      remediation: strOrNull(software.remediation),
    });
  }
  return entries;
}

interface CacheFile {
  version: number;
  source: string;
  updatedAt: string;
  records: number;
  entries: Array<[string, CompactVuln[]]>;
}

class FeedError extends Error {}

/**
 * Wordfence Intelligence V3 vulnerability feed: downloads the full feed (streamed, record by
 * record), keeps a compact in-memory index by software, and persists it so a restart does not
 * re-download. Never throws from refresh: failures are kept as a Dutch `error` message.
 */
export class WordfenceFeed {
  private index = new Map<string, CompactVuln[]>();
  private updatedAt: string | null = null;
  private records: number | null = null;
  private error: string | null = null;
  private lastFailureAt = 0;
  private inFlight: Promise<boolean> | undefined;
  private readonly feed: WordfenceFeedName;
  private readonly refreshMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: WordfenceFeedOptions = {}) {
    this.feed = options.feed ?? 'production';
    this.refreshMs = (options.refreshHours ?? 12) * 3_600_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((m) => process.stderr.write(`[wp-dashboard] ${m}\n`));
  }

  get enabled(): boolean {
    return !!this.options.apiKey;
  }

  get source(): string {
    return `wordfence-intelligence-v3-${this.feed}`;
  }

  hasData(): boolean {
    return this.updatedAt !== null;
  }

  status(): VulnerabilityFeedStatus {
    return { enabled: this.enabled, source: this.source, updatedAt: this.updatedAt, records: this.records, error: this.error };
  }

  /** Known vulnerabilities for one installed piece of software (all versions). */
  lookup(type: SoftwareType, slug: string): CompactVuln[] {
    return this.index.get(indexKey(type, slug)) ?? [];
  }

  /** Loads the persisted index (if any, and for the same feed). Never throws. */
  loadCache(): boolean {
    const file = this.options.cacheFile;
    if (!this.enabled || !file || !existsSync(file)) return false;
    try {
      const cache = JSON.parse(readFileSync(file, 'utf8')) as CacheFile;
      if (cache.version !== CACHE_VERSION || cache.source !== this.source || !Array.isArray(cache.entries)) return false;
      this.index = new Map(cache.entries);
      this.updatedAt = cache.updatedAt;
      this.records = cache.records;
      return true;
    } catch (err) {
      this.log(`wordfence cache unreadable, ignoring: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** True when the index is missing or older than the refresh interval (with a back-off after failures). */
  isDue(): boolean {
    if (!this.enabled) return false;
    const now = this.now();
    if (this.lastFailureAt && now - this.lastFailureAt < RETRY_AFTER_FAILURE_MS) return false;
    return this.updatedAt === null || now - Date.parse(this.updatedAt) >= this.refreshMs;
  }

  async refreshIfDue(): Promise<boolean> {
    return this.isDue() ? this.refresh() : false;
  }

  /** Downloads the feed and swaps in the new index. Concurrent calls share one download. */
  refresh(): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    this.inFlight ??= this.download().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private redact(message: string): string {
    const key = this.options.apiKey;
    const clean = key ? message.split(key).join('[redacted]') : message;
    return sanitizeMessage(clean).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  }

  private async download(): Promise<boolean> {
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(FEED_URL(this.feed), {
          headers: { Authorization: `Bearer ${this.options.apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (err) {
        throw new FeedError(`Wordfence-feed niet bereikbaar: ${this.redact(err instanceof Error ? err.message : String(err))}`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new FeedError(`Wordfence weigert de API-sleutel (HTTP ${response.status}). Controleer WORDFENCE_API_KEY.`);
      }
      if (response.status === 429) {
        throw new FeedError('Wordfence-limiet bereikt (HTTP 429). Het dashboard probeert het later opnieuw.');
      }
      if (!response.ok || !response.body) {
        throw new FeedError(`Wordfence-feed ophalen mislukt (HTTP ${response.status}).`);
      }

      const index = new Map<string, CompactVuln[]>();
      let records = 0;
      try {
        for await (const text of splitTopLevelRecords(response.body as unknown as AsyncIterable<Uint8Array>)) {
          records += 1;
          for (const entry of compactRecord(JSON.parse(text))) {
            const key = indexKey(entry.type, entry.slug);
            const list = index.get(key);
            if (list) list.push(entry);
            else index.set(key, [entry]);
          }
        }
      } catch (err) {
        throw new FeedError(`Wordfence-feed onleesbaar: ${this.redact(err instanceof Error ? err.message : String(err))}`);
      }

      this.index = index;
      this.records = records;
      this.updatedAt = new Date(this.now()).toISOString();
      this.error = null;
      this.lastFailureAt = 0;
      this.persist();
      this.log(`wordfence feed refreshed: ${records} records, ${index.size} software entries`);
      return true;
    } catch (err) {
      this.error = err instanceof FeedError ? err.message : `Wordfence-feed verwerken mislukt: ${this.redact(String(err))}`;
      this.lastFailureAt = this.now();
      this.log(`wordfence feed refresh failed: ${this.error}`);
      return false;
    }
  }

  private persist(): void {
    const file = this.options.cacheFile;
    if (!file || this.updatedAt === null || this.records === null) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const cache: CacheFile = {
        version: CACHE_VERSION, source: this.source, updatedAt: this.updatedAt, records: this.records, entries: [...this.index],
      };
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      this.log(`wordfence cache not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
