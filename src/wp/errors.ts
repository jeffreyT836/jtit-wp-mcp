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

/** True if `err` looks like a WP REST JSON error body: `{code: string, message: string}`. */
export function isWpJsonError(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).code === 'string' &&
    typeof (value as Record<string, unknown>).message === 'string'
  );
}
