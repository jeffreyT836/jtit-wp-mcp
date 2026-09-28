import { readFileSync } from 'node:fs';
import type { ResolvedSite, SiteConfig } from './schema.js';
import { sitesFileSchema } from './schema.js';

/** Thrown when a legacy `sites.json` is missing, unreadable, or fails schema validation. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
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

/**
 * Combines a site with its (possibly missing) application password into a
 * {@link ResolvedSite}, marking it unavailable when the secret is missing or the URL scheme
 * is disallowed. Shared by the SQLite site store and the legacy sites.json importer.
 */
export function resolveSite(
  site: SiteConfig,
  password: string | null,
  secretReason: string | null = password === null ? 'no application password stored' : null,
): ResolvedSite {
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

/** A legacy sites.json entry with its secret resolved from the environment. */
export interface LegacyResolvedSite {
  site: SiteConfig;
  password: string | null;
  unavailableReason: string | null;
}

/**
 * Loads and validates a legacy `sites.json`, resolving each site's secret from
 * `env[passwordEnv]` (or its `_FILE` variant). Only used by `cli sites import` to migrate
 * into the site store. Throws {@link ConfigError} on missing/unparsable/invalid files.
 */
export function loadLegacySitesFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): LegacyResolvedSite[] {
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

  return result.data.sites.map(({ passwordEnv, ...site }) => {
    const { password, reason } = resolveSecret(passwordEnv, env);
    return { site, password, unavailableReason: reason };
  });
}
