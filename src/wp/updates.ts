import { validatePluginId } from '../tools/plugins.js';
import { validateThemeId } from '../tools/themes.js';
import type { WpClient } from './client.js';

/**
 * Update logic around the nb-mcp-bridge update endpoints (SPEC.md §5), shared by the MCP
 * update tools (src/tools/updates.ts) and the dashboard.
 */

export interface BridgeUpdatesPlugin {
  plugin: string;
  name?: string;
  current_version?: string;
  new_version?: string;
  package_available?: boolean;
}

export interface BridgeUpdatesTheme {
  stylesheet: string;
  name?: string;
  current_version?: string;
  new_version?: string;
  package_available?: boolean;
}

export interface BridgeUpdatesCore {
  /** Installed version (same for every entry). */
  current?: string;
  /** The offer's target version. */
  version?: string;
  response?: string;
  locale?: string;
  /** Whether the offer is a same-branch minor/security release or a major (x.y) bump. */
  type?: 'minor' | 'major';
}

export interface BridgeUpdates {
  checked_at?: string;
  core?: BridgeUpdatesCore[];
  plugins?: BridgeUpdatesPlugin[];
  themes?: BridgeUpdatesTheme[];
  translations?: { count: number };
}

/** Strips a trailing ".php" from a plugin file, e.g. "akismet/akismet.php" -> "akismet/akismet". */
export function stripPhp(file: string): string {
  return file.endsWith('.php') ? file.slice(0, -4) : file;
}

/** `GET /nb-mcp/v1/updates` — the nb-mcp-bridge update-check endpoint. See SPEC.md §5. */
export async function fetchBridgeUpdates(client: WpClient, refresh?: boolean): Promise<BridgeUpdates> {
  return client.bridge<BridgeUpdates>('/updates', { query: refresh ? { refresh: 1 } : undefined });
}

export interface PluginUpdateTarget {
  /** Files to actually POST to `/updates/plugins` — only those with a pending update. */
  files: string[];
  preview: Array<{ plugin: string; from?: string; to?: string }>;
  /** Explicitly requested plugins that have no pending update, per SPEC.md — never listed as would-update. */
  noUpdateAvailable: Array<{ plugin: string; status: 'no_update_available' }>;
}

export async function resolvePluginUpdateTargets(
  args: { plugins?: string[]; all?: boolean },
  client: WpClient,
): Promise<PluginUpdateTarget> {
  if (!args.all && (!args.plugins || args.plugins.length === 0)) {
    throw new Error('update_plugins requires either a non-empty "plugins" array or "all: true"');
  }
  // Refresh, not cached: after any bridge update WP clears its update transients, so a
  // cached /updates list would show a just-confirmed update as no longer available.
  const updates = await fetchBridgeUpdates(client, true);
  const byRoute = new Map((updates.plugins ?? []).map((p) => [stripPhp(p.plugin), p]));

  if (args.all) {
    const entries = updates.plugins ?? [];
    return {
      files: entries.map((p) => p.plugin),
      preview: entries.map((p) => ({ plugin: stripPhp(p.plugin), from: p.current_version, to: p.new_version })),
      noUpdateAvailable: [],
    };
  }

  const validated = (args.plugins ?? []).map(validatePluginId);
  const files: string[] = [];
  const preview: Array<{ plugin: string; from?: string; to?: string }> = [];
  const noUpdateAvailable: Array<{ plugin: string; status: 'no_update_available' }> = [];
  for (const v of validated) {
    const info = byRoute.get(v.route);
    if (info) {
      files.push(v.file);
      preview.push({ plugin: v.route, from: info.current_version, to: info.new_version });
    } else {
      noUpdateAvailable.push({ plugin: v.route, status: 'no_update_available' });
    }
  }
  return { files, preview, noUpdateAvailable };
}

export interface ThemeUpdateTarget {
  /** Stylesheets to actually POST to `/updates/themes` — only those with a pending update. */
  files: string[];
  preview: Array<{ theme: string; from?: string; to?: string }>;
  /** Explicitly requested themes that have no pending update — never listed as would-update. */
  noUpdateAvailable: Array<{ theme: string; status: 'no_update_available' }>;
}

export async function resolveThemeUpdateTargets(
  args: { themes?: string[]; all?: boolean },
  client: WpClient,
): Promise<ThemeUpdateTarget> {
  if (!args.all && (!args.themes || args.themes.length === 0)) {
    throw new Error('update_themes requires either a non-empty "themes" array or "all: true"');
  }
  // Refresh, not cached: after any bridge update WP clears its update transients, so a
  // cached /updates list would show a just-confirmed update as no longer available.
  const updates = await fetchBridgeUpdates(client, true);
  const byStylesheet = new Map((updates.themes ?? []).map((t) => [t.stylesheet, t]));

  if (args.all) {
    const entries = updates.themes ?? [];
    return {
      files: entries.map((t) => t.stylesheet),
      preview: entries.map((t) => ({ theme: t.stylesheet, from: t.current_version, to: t.new_version })),
      noUpdateAvailable: [],
    };
  }

  const validated = (args.themes ?? []).map(validateThemeId);
  const files: string[] = [];
  const preview: Array<{ theme: string; from?: string; to?: string }> = [];
  const noUpdateAvailable: Array<{ theme: string; status: 'no_update_available' }> = [];
  for (const stylesheet of validated) {
    const info = byStylesheet.get(stylesheet);
    if (info) {
      files.push(stylesheet);
      preview.push({ theme: stylesheet, from: info.current_version, to: info.new_version });
    } else {
      noUpdateAvailable.push({ theme: stylesheet, status: 'no_update_available' });
    }
  }
  return { files, preview, noUpdateAvailable };
}

/**
 * Compares two dotted version strings numerically, per segment (e.g. "7.0.10" > "7.0.9",
 * unlike a lexicographic string compare). Missing/non-numeric segments count as 0.
 */
export function compareVersions(a: string, b: string): number {
  const as = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const bs = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function highestOffer(offers: BridgeUpdatesCore[]): BridgeUpdatesCore {
  return offers.reduce((best, offer) =>
    compareVersions(offer.version ?? '', best.version ?? '') > 0 ? offer : best,
  );
}

export interface CoreUpdateSelection {
  /** The offer to install, per the bridge's own selection rules. */
  chosen?: BridgeUpdatesCore;
  /** Set when `allow_major` is false and only a major-branch offer is available — the
   *  caller should be told a confirmed run would be refused unless they pass allow_major. */
  blockingMajor?: BridgeUpdatesCore;
}

/**
 * Mirrors `nb_mcp_bridge_select_core_update()` exactly (see wordpress/nb-mcp-bridge/
 * nb-mcp-bridge.php and SPEC.md §5): with `allowMajor` false, only same-branch
 * (`type !== 'major'`) offers are eligible and the highest of those (by target `version`)
 * is chosen; with `allowMajor` true, the highest offer overall is chosen. Offers whose
 * target `version` is not actually newer than the installed `current` are ignored.
 */
export function selectCoreUpdate(offers: BridgeUpdatesCore[], allowMajor: boolean): CoreUpdateSelection {
  const eligible = offers.filter(
    (o) => !!o.version && !!o.current && compareVersions(o.version, o.current) > 0,
  );
  const sameBranch = eligible.filter((o) => o.type !== 'major');
  const otherBranch = eligible.filter((o) => o.type === 'major');

  if (allowMajor) {
    const candidates = [...sameBranch, ...otherBranch];
    return candidates.length > 0 ? { chosen: highestOffer(candidates) } : {};
  }

  if (sameBranch.length > 0) {
    return { chosen: highestOffer(sameBranch) };
  }
  return otherBranch.length > 0 ? { blockingMajor: highestOffer(otherBranch) } : {};
}

/** Resolves the core update the bridge would install, via a *fresh* (non-cached) update check. */
export async function resolveCoreUpdate(client: WpClient, allowMajor: boolean): Promise<CoreUpdateSelection> {
  const updates = await fetchBridgeUpdates(client, true);
  return selectCoreUpdate(updates.core ?? [], allowMajor);
}

/** True when a bridge `/updates/core` or `/updates/translations` response means "nothing to do", not a failure. */
export function isCoreNoUpdate(data: { success?: boolean; from?: string; to?: string; error?: string; no_update?: boolean }): boolean {
  if (data.no_update === true) return true;
  return (
    data.success === false &&
    typeof data.from === 'string' &&
    data.from === data.to &&
    !!data.error &&
    /no core update/i.test(data.error)
  );
}

/** One health check the bridge ran after a safe update (bridge 1.1.0+). */
export interface BridgeHealthCheck {
  target: string;
  ok: boolean;
  status?: number;
  error?: string;
  /** Already failing before the update, so it does not count. */
  ignored?: boolean;
  /** Error log only: whether a readable log was found. */
  available?: boolean;
}

/** Extra fields a bridge 1.1.0+ adds to every result row in safe mode. */
export interface BridgeSafeFields {
  backup?: 'created' | 'none' | 'failed';
  health?: { ok: boolean; checks: BridgeHealthCheck[] };
  rolled_back?: boolean;
  rollback_error?: string;
  backup_path?: string;
}

export interface BridgeUpdateRow extends BridgeSafeFields {
  success: boolean;
  from?: string;
  to?: string;
  error?: string;
  no_update?: boolean;
}

export interface BridgePluginUpdateResponse {
  results?: Array<BridgeUpdateRow & { plugin: string }>;
}

export interface BridgeThemeUpdateResponse {
  results?: Array<BridgeUpdateRow & { theme: string }>;
}

export interface BridgeCoreUpdateResponse extends BridgeSafeFields {
  success?: boolean;
  from?: string;
  to?: string;
  error?: string;
  no_update?: boolean;
}

/** Safe mode: backup → update → health check → automatic restore, on the server (bridge 1.1.0+). */
export interface SafeUpdateOptions {
  safe?: boolean;
  healthPaths?: string[];
}

const safeBody = (opts: SafeUpdateOptions = {}) =>
  opts.safe ? { safe: true, health_paths: opts.healthPaths ?? [] } : {};

export interface BridgeTranslationUpdateResponse {
  success?: boolean;
  count?: number;
  failed?: number;
  errors?: string[];
  error?: string;
  no_update?: boolean;
}

/** `POST /updates/plugins` for plugin files that were resolved as having a pending update. */
export function postPluginUpdates(
  client: WpClient,
  files: string[],
  timeoutMs: number,
  opts?: SafeUpdateOptions,
): Promise<BridgePluginUpdateResponse> {
  return client.bridge<BridgePluginUpdateResponse>('/updates/plugins', {
    method: 'POST',
    body: { plugins: files, ...safeBody(opts) },
    timeoutMs,
  });
}

/** `POST /updates/themes` for stylesheets that were resolved as having a pending update. */
export function postThemeUpdates(
  client: WpClient,
  stylesheets: string[],
  timeoutMs: number,
  opts?: SafeUpdateOptions,
): Promise<BridgeThemeUpdateResponse> {
  return client.bridge<BridgeThemeUpdateResponse>('/updates/themes', {
    method: 'POST',
    body: { themes: stylesheets, ...safeBody(opts) },
    timeoutMs,
  });
}

/** `POST /updates/core`; the bridge applies the same selection rules as {@link selectCoreUpdate}. */
export function postCoreUpdate(
  client: WpClient,
  allowMajor: boolean,
  timeoutMs: number,
  opts?: SafeUpdateOptions,
): Promise<BridgeCoreUpdateResponse> {
  return client.bridge<BridgeCoreUpdateResponse>('/updates/core', {
    method: 'POST',
    body: { allow_major: allowMajor, ...safeBody(opts) },
    timeoutMs,
  });
}

/** `POST /updates/translations`. */
export function postTranslationUpdates(client: WpClient, timeoutMs: number): Promise<BridgeTranslationUpdateResponse> {
  return client.bridge<BridgeTranslationUpdateResponse>('/updates/translations', { method: 'POST', timeoutMs });
}

/** `GET /status` — used to check whether the installed bridge supports safe updates. */
export async function bridgeSupportsSafeUpdates(client: WpClient): Promise<{ ok: boolean; version?: string }> {
  const status = await client.bridge<{ bridge_version?: string; features?: string[] }>('/status');
  return { ok: (status.features ?? []).includes('safe_updates'), version: status.bridge_version };
}
