import { z } from 'zod';

/** Matches SPEC.md §1: `sites.json` site id format. */
export const siteIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'site id must match ^[a-z0-9][a-z0-9-]{1,48}$');

/** Matches SPEC.md §1: env var name used to hold a site's application password. */
export const passwordEnvSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]+$/, 'passwordEnv must match ^[A-Z][A-Z0-9_]+$');

export const siteConfigSchema = z.object({
  id: siteIdSchema,
  name: z.string().min(1),
  url: z.string().url(),
  username: z.string().min(1),
  passwordEnv: passwordEnvSchema,
  tags: z.array(z.string()).default([]),
  readOnly: z.boolean().default(false),
  allowHttp: z.boolean().default(false),
  bridge: z.boolean().default(true),
});

export type SiteConfigInput = z.input<typeof siteConfigSchema>;
export type SiteConfig = z.output<typeof siteConfigSchema>;

export const sitesFileSchema = z.object({
  sites: z.array(siteConfigSchema).min(1),
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

export interface AppConfig {
  sites: ResolvedSite[];
}

/** Global environment configuration, parsed once at startup. See SPEC.md §1. */
export const envSchema = z.object({
  SITES_CONFIG: z.string().optional(),
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
