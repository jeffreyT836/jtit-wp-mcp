import type { ResolvedSite } from '../config/schema.js';
import { assertSiteAccessible, isWpJsonError, WpError } from './errors.js';

export type FetchLike = typeof fetch;

export type QueryValue = string | number | boolean | undefined;

export interface WpRequestOptions {
  method?: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  timeoutMs?: number;
}

export interface WpClientOptions {
  /** Injectable fetch implementation, for tests. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Default per-request timeout in ms when not overridden per call. */
  defaultTimeoutMs?: number;
}

const MAX_PAGES = 20;
const DEFAULT_PER_PAGE = 100;

function buildQueryString(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Thin HTTP client for one WordPress site's REST API, authenticated with an
 * Application Password (HTTP Basic). See SPEC.md §3 for the contract.
 */
export class WpClient {
  private readonly site: ResolvedSite;
  private readonly fetchImpl: FetchLike;
  private readonly defaultTimeoutMs: number;

  constructor(site: ResolvedSite, options: WpClientOptions = {}) {
    this.site = site;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30000;
  }

  private get baseUrl(): string {
    return `${this.site.url.replace(/\/+$/, '')}/wp-json`;
  }

  private authHeader(): string {
    if (!this.site.password) {
      throw new WpError({
        status: 0,
        code: 'nb_mcp_no_secret',
        message: `no application password is configured for site ${this.site.id}`,
        site: this.site.id,
      });
    }
    const token = Buffer.from(`${this.site.username}:${this.site.password}`).toString('base64');
    return `Basic ${token}`;
  }

  private async rawRequest<T>(
    path: string,
    options: WpRequestOptions = {},
  ): Promise<{ data: T; headers: Headers }> {
    assertSiteAccessible(this.site);
    const url = `${this.baseUrl}${path}${buildQueryString(options.query)}`;
    const method = options.method ?? 'GET';
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const isAbort =
        err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      throw new WpError({
        status: 0,
        code: isAbort ? 'nb_mcp_timeout' : 'nb_mcp_network_error',
        message: isAbort
          ? `request to ${this.site.id} timed out after ${timeoutMs}ms`
          : `request to ${this.site.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        site: this.site.id,
      });
    }

    if (response.status === 204) {
      return { data: undefined as T, headers: response.headers };
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      if (isWpJsonError(parsed)) {
        throw new WpError({
          status: response.status,
          code: parsed.code,
          message: parsed.message,
          site: this.site.id,
        });
      }
      throw new WpError({
        status: response.status,
        code: 'nb_mcp_http_error',
        message: `HTTP ${response.status} ${response.statusText} from ${this.site.id}`,
        site: this.site.id,
      });
    }

    return { data: parsed as T, headers: response.headers };
  }

  /** Performs one request against `/wp-json<path>` and returns the parsed JSON body. */
  async request<T>(path: string, options: WpRequestOptions = {}): Promise<T> {
    const { data } = await this.rawRequest<T>(path, options);
    return data;
  }

  /**
   * Fetches every page of a collection endpoint using `X-WP-TotalPages`, at
   * `per_page=100`, capped at {@link MAX_PAGES} pages regardless of what the server reports.
   */
  async getAll<T>(
    path: string,
    query: Record<string, QueryValue> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    while (page <= MAX_PAGES) {
      const { data, headers } = await this.rawRequest<T[]>(path, {
        query: { ...query, per_page: DEFAULT_PER_PAGE, page },
        timeoutMs: options.timeoutMs,
      });
      const items = Array.isArray(data) ? data : [];
      results.push(...items);
      const totalPages = Number.parseInt(headers.get('x-wp-totalpages') ?? '1', 10) || 1;
      if (page >= totalPages || items.length === 0) break;
      page += 1;
    }
    return results;
  }

  /**
   * Convenience wrapper for the `nb-mcp-bridge` mu-plugin's routes (`/wp-json/nb-mcp/v1<path>`).
   * Refuses when the site is configured with `bridge: false`, and turns a 404
   * `rest_no_route` into a friendly "mu-plugin not installed" error.
   */
  async bridge<T>(path: string, options: WpRequestOptions = {}): Promise<T> {
    if (this.site.bridge === false) {
      throw new WpError({
        status: 0,
        code: 'nb_mcp_bridge_disabled',
        message: `nb-mcp-bridge is disabled for site ${this.site.id} (bridge: false in config)`,
        site: this.site.id,
      });
    }
    try {
      return await this.request<T>(`/nb-mcp/v1${path}`, options);
    } catch (err) {
      if (err instanceof WpError && err.status === 404 && err.code === 'rest_no_route') {
        throw new WpError({
          status: 404,
          code: 'nb_mcp_bridge_missing',
          message: `nb-mcp-bridge mu-plugin not installed on ${this.site.id}`,
          site: this.site.id,
        });
      }
      throw err;
    }
  }
}
