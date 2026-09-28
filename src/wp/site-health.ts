import type { WpClient } from './client.js';

/** Shared Site Health logic (nb-mcp-bridge 1.2.0 `GET /site-health`) for MCP tools and dashboard. */

export type HealthStatus = 'good' | 'recommended' | 'critical';

export interface HealthTest {
  test: string;
  label: string;
  status: HealthStatus;
  badge: { label: string; color: string };
  /** Plain text; paragraphs separated by newlines. */
  description: string;
  actions: Array<{ label: string; url: string }>;
}

export interface HealthInfo {
  wp_version?: string;
  php_version?: string;
  db_server?: string;
  db_version?: string;
  memory_limit?: string;
  wp_memory_limit?: string;
  max_execution_time?: string;
  upload_max_filesize?: string;
  post_max_size?: string;
  https?: boolean;
  object_cache?: boolean;
  wp_cron_disabled?: boolean;
  cron_overdue?: number;
  environment_type?: string;
  multisite?: boolean;
  language?: string;
  timezone?: string;
  theme?: string;
  plugins_active?: number;
  plugins_total?: number;
  mu_plugins?: number;
  image_editor?: string;
  sizes?: Record<string, { size: string; raw: number | null }>;
}

export interface SiteHealth {
  checked_at: string;
  summary: { critical: number; recommended: number; good: number };
  tests: HealthTest[];
  info: HealthInfo;
}

/** Health checks run loopback and wordpress.org requests; allow them time. */
export const SITE_HEALTH_TIMEOUT_MS = 120_000;

export interface BridgeStatus {
  bridge_version?: string;
  features?: string[];
  multisite?: boolean;
  main_site_id?: number | null;
}

/** Thrown when the site's bridge predates a feature the caller needs. */
export class BridgeFeatureMissingError extends Error {
  constructor(
    readonly feature: string,
    readonly version: string | undefined,
  ) {
    super(`nb-mcp-bridge ${version ?? '(unknown version)'} does not support "${feature}"; update it to 1.2.0 or later`);
    this.name = 'BridgeFeatureMissingError';
  }
}

export async function bridgeStatus(client: WpClient): Promise<BridgeStatus> {
  return (await client.bridge<BridgeStatus>('/status')) ?? {};
}

/** Returns the bridge status, or throws {@link BridgeFeatureMissingError}. */
export async function requireBridgeFeature(client: WpClient, feature: string): Promise<BridgeStatus> {
  const status = await bridgeStatus(client);
  if (!(status.features ?? []).includes(feature)) throw new BridgeFeatureMissingError(feature, status.bridge_version);
  return status;
}

export async function fetchSiteHealth(
  client: WpClient,
  opts: { includeSizes?: boolean; timeoutMs?: number } = {},
): Promise<SiteHealth> {
  await requireBridgeFeature(client, 'site_health');
  return client.bridge<SiteHealth>('/site-health', {
    query: opts.includeSizes ? { include_sizes: 1 } : undefined,
    timeoutMs: opts.timeoutMs ?? SITE_HEALTH_TIMEOUT_MS,
  });
}
