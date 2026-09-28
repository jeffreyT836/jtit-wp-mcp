import { z } from 'zod';

/** Matches SPEC.md §1: `sites.json` site id format. */
export const siteIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'site id must match ^[a-z0-9][a-z0-9-]{1,48}$');

/** Matches SPEC.md §1: env var name used to hold a site's application password. */
export const passwordEnvSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]+$/, 'passwordEnv must match ^[A-Z][A-Z0-9_]+$');

/** Site-relative page checked after safe updates, e.g. "/winkel". Never a full URL (no SSRF). */
export const healthPathSchema = z
  .string()
  .max(200)
  .regex(/^\/(?!\/)[^\s\\]*$/, 'controle-pagina moet een pad zijn dat met één "/" begint, zonder spaties');

export const MAX_HEALTH_PATHS = 10;

export const siteConfigSchema = z.object({
  id: siteIdSchema,
  name: z.string().min(1),
  url: z.string().url(),
  username: z.string().min(1),
  tags: z.array(z.string()).default([]),
  readOnly: z.boolean().default(false),
  allowHttp: z.boolean().default(false),
  bridge: z.boolean().default(true),
  healthPaths: z.array(healthPathSchema).max(MAX_HEALTH_PATHS).default([]),
});

export type SiteConfigInput = z.input<typeof siteConfigSchema>;
export type SiteConfig = z.output<typeof siteConfigSchema>;

/**
 * Legacy `sites.json` entry: a site plus the name of the env var holding its application
 * password. Only used by `cli sites import` to migrate an old sites.json + .env into the store.
 */
export const legacySiteConfigSchema = siteConfigSchema.extend({
  passwordEnv: passwordEnvSchema,
});

export type LegacySiteConfig = z.output<typeof legacySiteConfigSchema>;

export const sitesFileSchema = z.object({
  sites: z.array(legacySiteConfigSchema).min(1),
});

export type SitesFile = z.output<typeof sitesFileSchema>;

/**
 * A site after secret resolution and URL-scheme validation. `available` is false when
 * the site's application password secret could not be resolved, or the URL scheme is
 * disallowed; `unavailableReason` explains why, and never contains the secret itself.
 */
export interface ResolvedSite extends SiteConfig {
  password: string | null;
  available: boolean;
  unavailableReason: string | null;
}

/** Global environment configuration, parsed once at startup. See SPEC.md §1. */
export const envSchema = z.object({
  /** Path to the SQLite site store; see `resolveSitesDbPath` in src/store/site-store.ts. */
  SITES_DB: z.string().optional(),
  /** Base64 of 32 random bytes; encrypts application passwords at rest. */
  SITES_ENCRYPTION_KEY: z.string().optional(),
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(3000),
  MCP_HTTP_HOST: z.string().default('0.0.0.0'),
  MCP_HTTP_TOKEN: z.string().min(32).optional(),
  MCP_HTTP_ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1'),
  MCP_READ_ONLY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  WP_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  WP_UPDATE_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  FLEET_CONCURRENCY: z.coerce.number().int().positive().default(4),
  AUDIT_LOG_FILE: z.string().optional(),
});

export type EnvConfig = z.output<typeof envSchema>;

/** Environment for the dashboard process (`dist/dashboard/index.js`). */
export const dashboardEnvSchema = z.object({
  SITES_DB: z.string().optional(),
  SITES_ENCRYPTION_KEY: z.string().min(1, 'SITES_ENCRYPTION_KEY is required'),
  DASHBOARD_DB: z.string().optional(),
  DASHBOARD_HOST: z.string().default('0.0.0.0'),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3001),
  DASHBOARD_INGEST_TOKEN: z.string().min(32, 'DASHBOARD_INGEST_TOKEN must be at least 32 chars'),
  /** Set to "false" only for local http:// development; cookies are Secure otherwise. */
  DASHBOARD_SECURE_COOKIES: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  WP_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  WP_UPDATE_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
});

export type DashboardEnv = z.output<typeof dashboardEnvSchema>;
