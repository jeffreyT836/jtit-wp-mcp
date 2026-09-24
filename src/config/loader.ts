import { existsSync, readFileSync } from 'node:fs';
import type { AppConfig, ResolvedSite, SiteConfig } from './schema.js';
import { sitesFileSchema } from './schema.js';

/** Thrown when `sites.json` is missing, unreadable, or fails schema validation. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_CONTAINER_PATH = '/app/config/sites.json';
const DEFAULT_LOCAL_PATH = './config/sites.json';

/** Resolves the sites.json path per SPEC.md §1's `SITES_CONFIG` fallback rule. */
export function resolveSitesConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SITES_CONFIG) {
    return env.SITES_CONFIG;
  }
  if (existsSync(DEFAULT_CONTAINER_PATH)) {
    return DEFAULT_CONTAINER_PATH;
  }
  return DEFAULT_LOCAL_PATH;
}

function readSecretFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Resolves a site's application password from `env[passwordEnv]`, falling back to the
 * contents of the file at `env[passwordEnv + "_FILE"]` (Docker/Compose secrets pattern).
 * Returns null when neither is available. Never throws, never logs the value.
 */
export function resolveSecret(
  passwordEnv: string,
  env: NodeJS.ProcessEnv,
): { password: string | null; reason: string | null } {
  const direct = env[passwordEnv];
  if (direct !== undefined && direct.trim() !== '') {
    return { password: direct.trim(), reason: null };
  }
  const fileVar = `${passwordEnv}_FILE`;
  const filePath = env[fileVar];
  if (filePath) {
    const fromFile = readSecretFile(filePath);
    if (fromFile !== null && fromFile !== '') {
      return { password: fromFile, reason: null };
    }
    return {
      password: null,
      reason: `secret file for ${fileVar} could not be read`,
    };
  }
  return {
    password: null,
    reason: `neither ${passwordEnv} nor ${fileVar} is set`,
  };
}

function resolveSite(site: SiteConfig, env: NodeJS.ProcessEnv): ResolvedSite {
  const { password, reason: secretReason } = resolveSecret(site.passwordEnv, env);

  let unavailableReason = secretReason;
  if (!site.url.startsWith('https://') && !site.allowHttp) {
    unavailableReason = 'site url is not https:// and allowHttp is not enabled';
  }

  return {
    ...site,
    password,
    available: unavailableReason === null,
    unavailableReason,
  };
}

/**
 * Loads and validates `sites.json`, resolving each site's secret from the environment.
 * Throws {@link ConfigError} on missing/unparsable/invalid files — callers (src/index.ts)
 * are expected to log the message to stderr and exit(1), per SPEC.md §1.
 */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `failed to read sites config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `sites config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = sitesFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `sites config at ${path} failed validation: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  const ids = new Set<string>();
  for (const site of result.data.sites) {
    if (ids.has(site.id)) {
      throw new ConfigError(`sites config at ${path} has duplicate site id: ${site.id}`);
    }
    ids.add(site.id);
  }

  const sites = result.data.sites.map((site) => resolveSite(site, env));

  for (const site of sites) {
    if (!site.available) {
      process.stderr.write(
        `[wp-fleet-mcp] warning: site "${site.id}" is unavailable: ${site.unavailableReason}\n`,
      );
    }
  }

  return { sites };
}
