import { validatePluginId } from '../tools/plugins.js';
import { validateThemeId } from '../tools/themes.js';
import type { WpClient } from '../wp/client.js';
import { WpError, sanitizeMessage } from '../wp/errors.js';
import {
  bridgeSupportsSafeUpdates,
  isCoreNoUpdate,
  postCoreUpdate,
  postPluginUpdates,
  postThemeUpdates,
  postTranslationUpdates,
  resolveCoreUpdate,
  resolvePluginUpdateTargets,
  resolveThemeUpdateTargets,
  stripPhp,
  type BridgeHealthCheck,
  type BridgeSafeFields,
  type BridgeUpdates,
  type SafeUpdateOptions,
} from '../wp/updates.js';
import type { SnapshotRow } from './db.js';

export const MAX_SELECTED_ITEMS = 200;

export interface UpdateSelection {
  core: boolean;
  allowMajor: boolean;
  plugins: string[];
  themes: string[];
  translations: boolean;
  /** Backup + health check + automatic restore, done by the bridge on the server. */
  safe: boolean;
}

export type UpdateKind = 'core' | 'plugin' | 'theme' | 'translations';
export type UpdateStatus = 'updated' | 'failed' | 'up_to_date' | 'skipped' | 'rolled_back' | 'rollback_failed';

export interface UpdateItemResult {
  kind: UpdateKind;
  id: string;
  from?: string;
  to?: string;
  status: UpdateStatus;
  message?: string;
  /** Safe mode: the checks that ran after the update. */
  checks?: BridgeHealthCheck[];
}

/** Thrown when safe mode is requested but the site's bridge is too old to honour it. */
export class SafeUpdatesUnsupportedError extends Error {}

/** WordPress error messages may contain markup (e.g. "<strong>Fout:</strong>"); show plain text. */
export const plainText = (value: string): string =>
  value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const KNOWN_CODES: Record<string, string> = {
  nb_mcp_site_unhealthy: 'De homepage gaf al een fout vóór de update; er is niets bijgewerkt.',
  nb_mcp_file_mods_disabled: 'Bestandswijzigingen zijn uitgeschakeld op deze site (DISALLOW_FILE_MODS).',
};

const errorMessage = (err: unknown): string => {
  if (err instanceof WpError) return KNOWN_CODES[err.code] ?? plainText(err.message);
  return plainText(sanitizeMessage(err instanceof Error ? err.message : String(err)));
};

const CHECK_LABELS: Record<string, string> = { home: 'homepage', login: 'inlogpagina', error_log: 'errorlog' };

/** Human summary of the checks that failed (ignoring pre-existing failures). */
export function failedChecks(checks: BridgeHealthCheck[] = []): string {
  return checks
    .filter((c) => !c.ok && !c.ignored)
    .map((c) => `${CHECK_LABELS[c.target] ?? c.target}: ${plainText(c.error ?? (c.status ? `HTTP ${c.status}` : 'fout'))}`)
    .join('; ');
}

/** Maps a bridge result row to a status, honouring the safe-mode fields. */
function outcome(row: { success?: boolean; no_update?: boolean; error?: string } & BridgeSafeFields): Pick<UpdateItemResult, 'status' | 'message' | 'checks'> {
  const checks = row.health?.checks;
  if (row.rolled_back && !row.rollback_error) {
    const why = failedChecks(checks);
    return { status: 'rolled_back', checks, message: `Fouten na de update, automatisch teruggezet${why ? ` (${why})` : ''}.` };
  }
  if (row.rollback_error) {
    const why = failedChecks(checks);
    const where = row.backup_path ? ` Backup staat in ${row.backup_path}.` : '';
    return {
      status: row.backup === 'created' ? 'rollback_failed' : 'failed',
      checks,
      message: `${plainText(row.rollback_error)}${why ? ` (${why})` : ''}${where}`,
    };
  }
  if (row.success) return { status: 'updated', checks };
  if (row.no_update) return { status: 'up_to_date' };
  return { status: 'failed', checks, message: plainText(row.error ?? 'update mislukt') };
}

const asList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200);

/** Parses the update form; throws on an oversized selection. */
export function parseUpdateSelection(body: Record<string, unknown>): UpdateSelection {
  const selection: UpdateSelection = {
    core: body.core === 'on',
    allowMajor: body.allow_major === 'on',
    plugins: [...new Set(asList(body.plugins))],
    themes: [...new Set(asList(body.themes))],
    translations: body.translations === 'on',
    safe: body.safe === 'on',
  };
  if (selection.plugins.length + selection.themes.length > MAX_SELECTED_ITEMS) {
    throw new Error(`te veel items geselecteerd (max ${MAX_SELECTED_ITEMS})`);
  }
  return selection;
}

export const isEmptySelection = (s: UpdateSelection): boolean =>
  !s.core && !s.translations && s.plugins.length === 0 && s.themes.length === 0;

async function runCore(client: WpClient, allowMajor: boolean, timeoutMs: number, safe: SafeUpdateOptions): Promise<UpdateItemResult> {
  try {
    const { chosen, blockingMajor } = await resolveCoreUpdate(client, allowMajor);
    if (!chosen && blockingMajor) {
      return {
        kind: 'core', id: 'wordpress', from: blockingMajor.current, to: blockingMajor.version, status: 'skipped',
        message: 'Dit is een major-versie; vink "Major-versie toestaan" aan om deze te installeren.',
      };
    }
    const data = await postCoreUpdate(client, allowMajor, timeoutMs, safe);
    if (isCoreNoUpdate(data)) return { kind: 'core', id: 'wordpress', from: data.from, status: 'up_to_date' };
    return { kind: 'core', id: 'wordpress', from: data.from, to: data.to, ...outcome({ ...data, error: data.error ?? 'core-update mislukt' }) };
  } catch (err) {
    return { kind: 'core', id: 'wordpress', status: 'failed', message: errorMessage(err) };
  }
}

/** Shared flow for plugins and themes: validate ids, resolve fresh targets, post, map results. */
async function runItems(
  kind: 'plugin' | 'theme',
  requested: string[],
  client: WpClient,
  timeoutMs: number,
  safe: SafeUpdateOptions,
): Promise<UpdateItemResult[]> {
  const results: UpdateItemResult[] = [];
  const valid: string[] = [];
  for (const raw of requested) {
    try {
      valid.push(kind === 'plugin' ? validatePluginId(raw).route : validateThemeId(raw));
    } catch (err) {
      results.push({ kind, id: raw, status: 'failed', message: errorMessage(err) });
    }
  }
  if (valid.length === 0) return results;

  try {
    if (kind === 'plugin') {
      const target = await resolvePluginUpdateTargets({ plugins: valid }, client);
      results.push(...target.noUpdateAvailable.map((n) => ({ kind, id: n.plugin, status: 'up_to_date' as const })));
      if (target.files.length === 0) return results;
      // Safe mode: one item per request, so each stays within the timeout and a
      // rollback only ever concerns that one item.
      const batches = safe.safe ? target.files.map((f) => [f]) : [target.files];
      for (const batch of batches) {
        const data = await postPluginUpdates(client, batch, timeoutMs, safe);
        for (const r of data.results ?? []) {
          results.push({ kind, id: stripPhp(r.plugin), from: r.from, to: r.to, ...outcome(r) });
        }
      }
    } else {
      const target = await resolveThemeUpdateTargets({ themes: valid }, client);
      results.push(...target.noUpdateAvailable.map((n) => ({ kind, id: n.theme, status: 'up_to_date' as const })));
      if (target.files.length === 0) return results;
      const batches = safe.safe ? target.files.map((f) => [f]) : [target.files];
      for (const batch of batches) {
        const data = await postThemeUpdates(client, batch, timeoutMs, safe);
        for (const r of data.results ?? []) {
          results.push({ kind, id: r.theme, from: r.from, to: r.to, ...outcome(r) });
        }
      }
    }
  } catch (err) {
    const done = new Set(results.map((r) => r.id));
    const message = errorMessage(err);
    results.push(...valid.filter((id) => !done.has(id)).map((id) => ({ kind, id, status: 'failed' as const, message })));
  }
  return results;
}

async function runTranslations(client: WpClient, timeoutMs: number): Promise<UpdateItemResult> {
  try {
    const data = await postTranslationUpdates(client, timeoutMs);
    const failed = data.failed ?? (data.success === false ? 1 : 0);
    if ((data.no_update === true || (data.count ?? 0) === 0) && failed === 0) {
      return { kind: 'translations', id: 'vertalingen', status: 'up_to_date' };
    }
    if (data.success === false || failed > 0) {
      const message = data.errors?.length ? data.errors.join('; ') : (data.error ?? 'vertalingen bijwerken mislukt');
      return { kind: 'translations', id: 'vertalingen', status: 'failed', message };
    }
    return { kind: 'translations', id: 'vertalingen', status: 'updated', message: `${data.count} vertaling(en) bijgewerkt` };
  } catch (err) {
    return { kind: 'translations', id: 'vertalingen', status: 'failed', message: errorMessage(err) };
  }
}

/**
 * Runs the selected updates in wp-cli order: core → plugins → themes → translations. Every
 * step re-checks with the bridge what is really pending; one failing step never stops the next.
 */
export async function runUpdates(
  client: WpClient,
  selection: UpdateSelection,
  timeoutMs: number,
  healthPaths: string[] = [],
): Promise<UpdateItemResult[]> {
  if (selection.safe) {
    // An older bridge would silently ignore `safe` and update without backup.
    const support = await bridgeSupportsSafeUpdates(client);
    if (!support.ok) {
      throw new SafeUpdatesUnsupportedError(
        `De nb-mcp-bridge op deze site (versie ${support.version ?? 'onbekend'}) ondersteunt nog geen veilig updaten. Werk hem bij naar 1.1.0 of zet "Veilig updaten" uit.`,
      );
    }
  }
  const safe: SafeUpdateOptions = { safe: selection.safe, healthPaths };
  const results: UpdateItemResult[] = [];
  if (selection.core) results.push(await runCore(client, selection.allowMajor, timeoutMs, safe));
  if (selection.plugins.length > 0) results.push(...(await runItems('plugin', selection.plugins, client, timeoutMs, safe)));
  if (selection.themes.length > 0) results.push(...(await runItems('theme', selection.themes, client, timeoutMs, safe)));
  if (selection.translations) results.push(await runTranslations(client, timeoutMs));
  return results;
}

export interface UpdatesSnapshot {
  collectedAt: string;
  data?: BridgeUpdates;
  error?: string;
}

/** The site's newest `fleet_updates_report` snapshot, in the per-site `{ site, ok, data }` shape. */
export function latestUpdates(snapshots: SnapshotRow[]): UpdatesSnapshot | undefined {
  const row = snapshots.find((s) => s.kind === 'fleet_updates_report');
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.data) as { ok?: boolean; data?: BridgeUpdates; error?: string };
    if (parsed.ok !== true || !parsed.data) {
      return { collectedAt: row.collected_at, error: plainText(parsed.error ?? 'update-check mislukt') };
    }
    return { collectedAt: row.collected_at, data: parsed.data };
  } catch {
    return { collectedAt: row.collected_at, error: 'ongeldige data' };
  }
}

/** Stores a live update check as a snapshot in the same shape n8n delivers. */
export function updatesSnapshotPayload(siteId: string, outcome: { data: BridgeUpdates } | { error: string }): string {
  return JSON.stringify('data' in outcome ? { site: siteId, ok: true, data: outcome.data } : { site: siteId, ok: false, error: outcome.error });
}

export { errorMessage as updateErrorMessage };
export type { BridgeHealthCheck };
