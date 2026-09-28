import type { ResolvedSite } from '../config/schema.js';
import { WpClient, type FetchLike } from './client.js';
import { assertSiteAccessible } from './errors.js';

/** Thrown by {@link SiteRegistry.get} when a site id is not present in the site store. */
export class SiteNotFoundError extends Error {
  constructor(id: string, knownIds: string[]) {
    super(
      `unknown site "${id}"; known site ids: ${knownIds.length > 0 ? knownIds.join(', ') : '(none configured)'}`,
    );
    this.name = 'SiteNotFoundError';
  }
}

/**
 * Where the registry gets its sites from. `version()` must change whenever `load()` would
 * return something different; it is checked on every lookup (the SQLite store makes this a
 * single-row read), so sites added via the CLI or dashboard apply without a restart.
 */
export interface SiteSource {
  version(): number;
  load(): ResolvedSite[];
}

export interface SiteRegistryOptions {
  /** Injectable fetch, forwarded to every WpClient this registry creates. */
  fetch?: FetchLike;
  defaultTimeoutMs?: number;
}

/**
 * Holds the resolved fleet of sites (SPEC.md §3) and vends a {@link WpClient} per site.
 * The registry is the only place allowed to talk to a site's URL — tool code never
 * accepts a user-supplied URL, which is the SSRF allowlist guarantee from SPEC.md §2.
 */
export class SiteRegistry {
  private sites = new Map<string, ResolvedSite>();
  private clients = new Map<string, WpClient>();
  private loadedVersion: number | null = null;
  private readonly source: SiteSource;
  private readonly options: SiteRegistryOptions;

  /** Accepts a fixed list of sites (tests) or a live {@link SiteSource} (the site store). */
  constructor(sites: ResolvedSite[] | SiteSource, options: SiteRegistryOptions = {}) {
    this.source = Array.isArray(sites) ? { version: () => 0, load: () => sites } : sites;
    this.options = options;
  }

  /** Reloads from the source when its version changed, dropping cached clients. */
  private current(): Map<string, ResolvedSite> {
    const version = this.source.version();
    if (version !== this.loadedVersion) {
      this.sites = new Map(this.source.load().map((site) => [site.id, site]));
      this.clients = new Map();
      this.loadedVersion = version;
    }
    return this.sites;
  }

  /** All configured sites, in the store's order. */
  list(): ResolvedSite[] {
    return [...this.current().values()];
  }

  /** Looks up a site by id, throwing {@link SiteNotFoundError} if unknown. */
  get(id: string): ResolvedSite {
    const sites = this.current();
    const site = sites.get(id);
    if (!site) {
      throw new SiteNotFoundError(id, [...sites.keys()]);
    }
    return site;
  }

  /**
   * Returns (creating and caching if needed) the {@link WpClient} for a site id. Refuses
   * (throws a {@link WpError} via {@link assertSiteAccessible}) when the site is unavailable
   * or has a non-https URL without `allowHttp` — defense-in-depth alongside the same check in
   * {@link WpClient}'s `rawRequest`, so an unavailable/insecure site is never contacted even by
   * a call path that only goes through the registry.
   */
  client(id: string): WpClient {
    const site = this.get(id);
    const existing = this.clients.get(id);
    if (existing) return existing;
    assertSiteAccessible(site);
    const client = new WpClient(site, {
      fetch: this.options.fetch,
      defaultTimeoutMs: this.options.defaultTimeoutMs,
    });
    this.clients.set(id, client);
    return client;
  }

  /** Sites that carry every tag in `tags` (AND semantics). Empty/omitted → all sites. */
  byTags(tags?: string[]): ResolvedSite[] {
    if (!tags || tags.length === 0) return this.list();
    return this.list().filter((site) => tags.every((tag) => site.tags.includes(tag)));
  }
}
