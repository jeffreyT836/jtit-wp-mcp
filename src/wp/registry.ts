import type { ResolvedSite } from '../config/schema.js';
import { WpClient, type FetchLike } from './client.js';
import { assertSiteAccessible } from './errors.js';

/** Thrown by {@link SiteRegistry.get} when a site id is not present in sites.json. */
export class SiteNotFoundError extends Error {
  constructor(id: string, knownIds: string[]) {
    super(
      `unknown site "${id}"; known site ids: ${knownIds.length > 0 ? knownIds.join(', ') : '(none configured)'}`,
    );
    this.name = 'SiteNotFoundError';
  }
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
  private readonly sites: Map<string, ResolvedSite>;
  private readonly clients = new Map<string, WpClient>();
  private readonly options: SiteRegistryOptions;

  constructor(sites: ResolvedSite[], options: SiteRegistryOptions = {}) {
    this.sites = new Map(sites.map((site) => [site.id, site]));
    this.options = options;
  }

  /** All configured sites, in declaration order. */
  list(): ResolvedSite[] {
    return [...this.sites.values()];
  }

  /** Looks up a site by id, throwing {@link SiteNotFoundError} if unknown. */
  get(id: string): ResolvedSite {
    const site = this.sites.get(id);
    if (!site) {
      throw new SiteNotFoundError(id, [...this.sites.keys()]);
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
    const existing = this.clients.get(id);
    if (existing) return existing;
    const site = this.get(id);
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
