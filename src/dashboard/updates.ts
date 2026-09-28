import { validatePluginId } from '../tools/plugins.js';
import { validateThemeId } from '../tools/themes.js';
import type { WpClient } from '../wp/client.js';
import { WpError, sanitizeMessage } from '../wp/errors.js';
import {
  isCoreNoUpdate,
  postCoreUpdate,
  postPluginUpdates,
  postThemeUpdates,
  postTranslationUpdates,
  resolveCoreUpdate,
  resolvePluginUpdateTargets,
  resolveThemeUpdateTargets,
  stripPhp,
  type BridgeUpdates,
} from '../wp/updates.js';
import type { SnapshotRow } from './db.js';

export const MAX_SELECTED_ITEMS = 200;

export interface UpdateSelection {
  core: boolean;
  allowMajor: boolean;
  plugins: string[];
  themes: string[];
  translations: boolean;
}

export type UpdateKind = 'core' | 'plugin' | 'theme' | 'translations';
export type UpdateStatus = 'updated' | 'failed' | 'up_to_date' | 'skipped';

export interface UpdateItemResult {
  kind: UpdateKind;
  id: string;
  from?: string;
  to?: string;
  status: UpdateStatus;
  message?: string;
}

const errorMessage = (err: unknown): string =>
  err instanceof WpError ? err.message : sanitizeMessage(err instanceof Error ? err.message : String(err));

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
  };
  if (selection.plugins.length + selection.themes.length > MAX_SELECTED_ITEMS) {
    throw new Error(`te veel items geselecteerd (max ${MAX_SELECTED_ITEMS})`);
  }
  return selection;
}

export const isEmptySelection = (s: UpdateSelection): boolean =>
  !s.core && !s.translations && s.plugins.length === 0 && s.themes.length === 0;

async function runCore(client: WpClient, allowMajor: boolean, timeoutMs: number): Promise<UpdateItemResult> {
  try {
    const { chosen, blockingMajor } = await resolveCoreUpdate(client, allowMajor);
    if (!chosen && blockingMajor) {
      return {
        kind: 'core', id: 'wordpress', from: blockingMajor.current, to: blockingMajor.version, status: 'skipped',
        message: 'Dit is een major-versie; vink "Major-versie toestaan" aan om deze te installeren.',
      };
    }
    const data = await postCoreUpdate(client, allowMajor, timeoutMs);
    if (isCoreNoUpdate(data)) return { kind: 'core', id: 'wordpress', from: data.from, status: 'up_to_date' };
    if (data.success === false) {
      return { kind: 'core', id: 'wordpress', from: data.from, to: data.to, status: 'failed', message: data.error ?? 'core-update mislukt' };
    }
    return { kind: 'core', id: 'wordpress', from: data.from, to: data.to, status: 'updated' };
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
      const data = await postPluginUpdates(client, target.files, timeoutMs);
      for (const r of data.results ?? []) {
        results.push({
          kind, id: stripPhp(r.plugin), from: r.from, to: r.to,
          status: r.success ? 'updated' : r.no_update ? 'up_to_date' : 'failed',
          ...(r.success || r.no_update ? {} : { message: r.error ?? 'update mislukt' }),
        });
      }
    } else {
      const target = await resolveThemeUpdateTargets({ themes: valid }, client);
      results.push(...target.noUpdateAvailable.map((n) => ({ kind, id: n.theme, status: 'up_to_date' as const })));
      if (target.files.length === 0) return results;
      const data = await postThemeUpdates(client, target.files, timeoutMs);
      for (const r of data.results ?? []) {
        results.push({
          kind, id: r.theme, from: r.from, to: r.to,
          status: r.success ? 'updated' : r.no_update ? 'up_to_date' : 'failed',
          ...(r.success || r.no_update ? {} : { message: r.error ?? 'update mislukt' }),
        });
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
export async function runUpdates(client: WpClient, selection: UpdateSelection, timeoutMs: number): Promise<UpdateItemResult[]> {
  const results: UpdateItemResult[] = [];
  if (selection.core) results.push(await runCore(client, selection.allowMajor, timeoutMs));
  if (selection.plugins.length > 0) results.push(...(await runItems('plugin', selection.plugins, client, timeoutMs)));
  if (selection.themes.length > 0) results.push(...(await runItems('theme', selection.themes, client, timeoutMs)));
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
      return { collectedAt: row.collected_at, error: parsed.error ?? 'update-check mislukt' };
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
