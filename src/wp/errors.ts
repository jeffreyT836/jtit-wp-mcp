import type { ResolvedSite } from '../config/schema.js';

/** Redacts an Application Password / Basic auth token from an arbitrary string. */
export function sanitizeMessage(message: string): string {
  return message
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]')
    .replace(/(Authorization["']?\s*[:=]\s*["']?)[^\s"'&]+/gi, '$1[redacted]')
    .replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, '://[redacted]@');
}

/**
 * A WordPress REST API error, normalized from either a WP JSON error body
 * (`{code, message}`) or a network/transport failure. `message` and `toString()` are
 * always sanitized — never include the site's password or an Authorization header.
 */
export class WpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly site: string;

  constructor(params: { status: number; code: string; message: string; site: string }) {
    const sanitized = sanitizeMessage(params.message);
    super(sanitized);
    this.name = 'WpError';
    this.status = params.status;
    this.code = params.code;
    this.site = params.site;
  }
}

/**
 * Refuses to let a site be contacted when it is unavailable, or when its base URL is not
 * `https://` and `allowHttp` is not enabled. This is defense-in-depth: `loadConfig` already
 * computes `available`/`unavailableReason` from these same conditions at startup (SPEC.md §1),
 * but every call path that reaches the network (WpClient.rawRequest, SiteRegistry.client)
 * re-checks here so a site can never be contacted by accident (e.g. a caller passing a
 * hand-built ResolvedSite, or a future code path that skips the registry's normal lookup).
 */
export function assertSiteAccessible(site: ResolvedSite): void {
  if (!site.available) {
    throw new WpError({
      status: 0,
      code: 'nb_mcp_site_unavailable',
      message: `refusing to contact site ${site.id}: ${site.unavailableReason ?? 'site is unavailable'}`,
      site: site.id,
    });
  }
  if (!site.url.startsWith('https://') && !site.allowHttp) {
    throw new WpError({
      status: 0,
      code: 'nb_mcp_insecure_url',
      message: `refusing to contact site ${site.id}: url is not https:// and allowHttp is not enabled`,
      site: site.id,
    });
  }
}

/** True if `err` looks like a WP REST JSON error body: `{code: string, message: string}`. */
export function isWpJsonError(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).code === 'string' &&
    typeof (value as Record<string, unknown>).message === 'string'
  );
}
