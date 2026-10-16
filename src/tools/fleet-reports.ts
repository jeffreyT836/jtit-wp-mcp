import type { ResolvedSite } from '../config/schema.js';
import type { WpClient } from '../wp/client.js';
import { WpError, sanitizeMessage } from '../wp/errors.js';
import { fetchSiteHealth, type SiteHealth } from '../wp/site-health.js';
import { fetchBridgeUpdates, type BridgeUpdates } from '../wp/updates.js';
import { runFleet, type FleetResult, type SkippedSite } from './helpers.js';

/**
 * Fleet reports shared by the MCP tools (`fleet_health`, `fleet_updates_report`,
 * `fleet_site_health`) and the dashboard's built-in sync, so both produce byte-for-byte the
 * same `{ summary, results, skipped }` shape that `/api/ingest` stores.
 */

export type ClientOf = (site: ResolvedSite) => WpClient;

interface WpUserMe {
  id: number;
  username?: string;
  slug?: string;
  roles?: string[];
}

interface BridgeStatusInfo {
  bridge_version?: string;
  wp_version?: string;
  php_version?: string;
}

type BridgeState = 'ok' | 'missing' | 'error' | 'disabled';

export interface FleetHealth {
  ok: boolean;
  user?: { id: number; username: string };
  roles: string[];
  bridge: BridgeState;
  versions?: BridgeStatusInfo;
  error?: string;
}

export async function fleetHealthForSite(client: WpClient, site: ResolvedSite): Promise<FleetHealth> {
  let ok = false;
  let user: { id: number; username: string } | undefined;
  let roles: string[] = [];
  let error: string | undefined;

  try {
    const me = await client.request<WpUserMe>('/wp/v2/users/me', { query: { context: 'edit' } });
    ok = true;
    roles = me.roles ?? [];
    user = { id: me.id, username: me.username ?? me.slug ?? '' };
  } catch (err) {
    error = err instanceof WpError ? err.message : sanitizeMessage(err instanceof Error ? err.message : String(err));
  }

  let bridge: BridgeState = 'disabled';
  let versions: BridgeStatusInfo | undefined;
  if (site.bridge !== false) {
    try {
      versions = await client.bridge<BridgeStatusInfo>('/status');
      bridge = 'ok';
    } catch (err) {
      bridge = err instanceof WpError && err.code === 'nb_mcp_bridge_missing' ? 'missing' : 'error';
    }
  }

  return { ok, user, roles, bridge, ...(versions ? { versions } : {}), ...(error ? { error } : {}) };
}

export interface FleetReport<T, S> {
  summary: S;
  results: FleetResult<T>[];
  skipped: SkippedSite[];
}

/** `fleet_health`: authenticated user, roles and bridge status per site. */
export async function fleetHealthReport(
  sites: ResolvedSite[],
  skipped: SkippedSite[],
  clientOf: ClientOf,
  concurrency: number,
): Promise<FleetReport<FleetHealth, { sites: number; ok: number; failed: number; skipped: number }>> {
  const results = await runFleet(sites, (site) => fleetHealthForSite(clientOf(site), site), concurrency);
  const summary = {
    sites: results.length,
    ok: results.filter((r) => r.ok && r.data?.ok).length,
    failed: results.filter((r) => !r.ok || !r.data?.ok).length,
    skipped: skipped.length,
  };
  return { summary, results, skipped };
}

/** `fleet_updates_report`: pending core/plugin/theme updates via the bridge. */
export async function fleetUpdatesReport(
  sites: ResolvedSite[],
  skipped: SkippedSite[],
  clientOf: ClientOf,
  concurrency: number,
  refresh?: boolean,
) {
  const results = await runFleet(sites, (site) => fetchBridgeUpdates(clientOf(site), refresh), concurrency);
  const totals = results.reduce(
    (acc, r: FleetResult<BridgeUpdates>) => {
      if (!r.ok || !r.data) {
        acc.failed += 1;
        return acc;
      }
      acc.pendingPlugins += r.data.plugins?.length ?? 0;
      acc.pendingThemes += r.data.themes?.length ?? 0;
      acc.pendingCore += (r.data.core ?? []).filter((c) => c.response === 'upgrade').length;
      return acc;
    },
    { failed: 0, pendingPlugins: 0, pendingThemes: 0, pendingCore: 0 },
  );
  return { summary: { sites: results.length, ...totals, skipped: skipped.length }, results, skipped };
}

/** `fleet_site_health`: WordPress Site Health on every site with the bridge enabled. */
export async function fleetSiteHealthReport(
  selected: ResolvedSite[],
  skipped: SkippedSite[],
  clientOf: ClientOf,
  concurrency: number,
  opts: { includeSizes?: boolean } = {},
) {
  const targets = selected.filter((site) => site.bridge !== false);
  const results = await runFleet(targets, (site) => fetchSiteHealth(clientOf(site), opts), concurrency);
  const summary = results.reduce(
    (acc, r: FleetResult<SiteHealth>) => {
      if (!r.ok || !r.data) acc.failed += 1;
      else {
        acc.critical += r.data.summary.critical;
        acc.recommended += r.data.summary.recommended;
      }
      return acc;
    },
    { sites: results.length, critical: 0, recommended: 0, failed: 0, skipped: skipped.length + selected.length - targets.length },
  );
  return { summary, results, skipped };
}
