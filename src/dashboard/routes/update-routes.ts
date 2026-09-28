import { Router, type Request, type Response } from 'express';
import type { ResolvedSite } from '../../config/schema.js';
import { fetchBridgeUpdates, stripPhp } from '../../wp/updates.js';
import { requireCsrf, requireFullAuth } from '../auth/session.js';
import { renderPage, type RouteContext } from '../context.js';
import {
  isEmptySelection,
  latestUpdates,
  parseUpdateSelection,
  runUpdates,
  SafeUpdatesUnsupportedError,
  updateErrorMessage,
  updatesSnapshotPayload,
  type UpdateItemResult,
} from '../updates.js';
import { updateResultPage } from '../views/update-views.js';
import { clientFor, renderSiteDetail } from './site-routes.js';

export function updateRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, store } = ctx;
  /** One update run per site at a time (double submit, two tabs). */
  const running = new Set<string>();

  router.use('/sites/:id/updates', requireFullAuth);

  const loadSite = (req: Request): ResolvedSite | undefined =>
    store.load().find((s) => s.id === req.params.id);

  /** Live update check (refresh) stored as a snapshot, like n8n does. Never throws. */
  async function snapshotLiveUpdates(site: ResolvedSite): Promise<boolean> {
    try {
      const data = await fetchBridgeUpdates(clientFor(ctx, site), true);
      db.insertSnapshot(site.id, 'fleet_updates_report', updatesSnapshotPayload(site.id, { data }), new Date().toISOString());
      return true;
    } catch (err) {
      db.insertSnapshot(
        site.id,
        'fleet_updates_report',
        updatesSnapshotPayload(site.id, { error: updateErrorMessage(err) }),
        new Date().toISOString(),
      );
      return false;
    }
  }

  const detailError = (res: Response, siteId: string, message: string, status = 422): void => {
    const stored = store.list().find((s) => s.id === siteId);
    if (!stored) {
      res.redirect(303, '/');
      return;
    }
    renderSiteDetail(ctx, res, stored, { kind: 'error', message }, status);
  };

  router.post('/sites/:id/updates/refresh', requireCsrf, async (req, res) => {
    const site = loadSite(req);
    if (!site) return res.redirect(303, '/');
    if (!site.available || !site.bridge) {
      return detailError(res, site.id, site.unavailableReason ?? 'Updates vereisen de nb-mcp-bridge.');
    }
    const ok = await snapshotLiveUpdates(site);
    db.audit(res.locals.auth!.user.email, 'updates_checked', site.id, { ok });
    res.redirect(303, `/sites/${site.id}?refreshed=1#updates`);
  });

  router.post('/sites/:id/updates', requireCsrf, async (req, res) => {
    const site = loadSite(req);
    if (!site) return res.redirect(303, '/');
    if (site.readOnly) return detailError(res, site.id, 'Deze site staat op "alleen lezen"; updates zijn uitgeschakeld.', 403);
    if (!site.available || !site.bridge) {
      return detailError(res, site.id, site.unavailableReason ?? 'Updates vereisen de nb-mcp-bridge.');
    }
    if (req.body?.confirm !== 'on') return detailError(res, site.id, 'Bevestig eerst dat je de updates wilt uitvoeren.');

    let selection;
    try {
      selection = parseUpdateSelection(req.body ?? {});
    } catch (err) {
      return detailError(res, site.id, err instanceof Error ? err.message : String(err));
    }
    if (selection.allowMajor && !selection.core) {
      return detailError(res, site.id, '"Major-versie toestaan" werkt alleen samen met "WordPress-core".');
    }
    if (isEmptySelection(selection)) return detailError(res, site.id, 'Selecteer minstens één update.');
    if (running.has(site.id)) {
      return detailError(res, site.id, 'Er loopt al een update voor deze site. Wacht tot die klaar is.', 409);
    }

    // Display names from the snapshot the user selected from.
    const known = latestUpdates(db.latestSnapshots(site.id))?.data;
    const names = new Map<string, string>([
      ...(known?.plugins ?? []).map((p) => [stripPhp(p.plugin), p.name ?? p.plugin] as [string, string]),
      ...(known?.themes ?? []).map((t) => [t.stylesheet, t.name ?? t.stylesheet] as [string, string]),
    ]);

    const actor = res.locals.auth!.user.email;
    running.add(site.id);
    let results: UpdateItemResult[];
    try {
      db.audit(actor, 'updates_started', site.id, {
        core: selection.core, allowMajor: selection.allowMajor, plugins: selection.plugins.length,
        themes: selection.themes.length, translations: selection.translations, safe: selection.safe,
      });
      results = await runUpdates(clientFor(ctx, site), selection, ctx.env.WP_UPDATE_TIMEOUT_MS, site.healthPaths);
      await snapshotLiveUpdates(site);
    } catch (err) {
      if (err instanceof SafeUpdatesUnsupportedError) return detailError(res, site.id, err.message, 409);
      throw err;
    } finally {
      running.delete(site.id);
    }

    const count = (status: UpdateItemResult['status']) => results.filter((r) => r.status === status).length;
    db.audit(actor, 'updates_run', site.id, {
      updated: count('updated'),
      failed: count('failed'),
      upToDate: count('up_to_date'),
      skipped: count('skipped'),
      rolledBack: count('rolled_back'),
      rollbackFailed: count('rollback_failed'),
      safe: selection.safe,
      items: results.map((r) => `${r.kind}:${r.id}:${r.status}${r.to ? `@${r.to}` : ''}`).slice(0, 50),
    });
    renderPage(res, {
      title: 'Updates uitgevoerd',
      body: updateResultPage({ site: store.list().find((s) => s.id === site.id)!, results, names }),
    });
  });

  return router;
}
