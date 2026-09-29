import { Router, type Response } from 'express';
import { sanitizeMessage } from '../../wp/errors.js';
import { scanSite, SEVERITY_ORDER, worstSeverity } from '../../wp/vulnerabilities.js';
import { acknowledgeAlert, evaluateSites, type AlertChange } from '../alerts.js';
import { requireCsrf, requireFullAuth } from '../auth/session.js';
import { renderPage, type RouteContext } from '../context.js';
import { latestUpdates } from '../updates.js';
import { latestVulnerabilities, VULN_KIND, vulnerabilitySnapshotPayload } from '../vulnerabilities.js';
import { alertsPage } from '../views/alert-views.js';
import { settingsPage } from '../views/site-pages.js';
import { vulnerabilitiesPage, type FleetFindingRow } from '../views/vulnerability-views.js';
import { clientFor, renderSiteDetail } from './site-routes.js';

/** Only same-site paths, never "//host" or a full URL (no open redirect). */
const safeBack = (value: unknown, fallback: string): string =>
  typeof value === 'string' && /^\/(?![/\\])[^\s]*$/.test(value) ? value : fallback;

/** Evaluates the newest snapshot of `kind` for a site and notifies transitions. */
export async function evaluateAndNotify(ctx: RouteContext, kind: string, siteIds: string[]): Promise<AlertChange[]> {
  const changes = evaluateSites(ctx.db, ctx.store.list(), kind, siteIds);
  await ctx.notifier.send(changes);
  return changes;
}

export function alertRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, store } = ctx;
  router.use(requireFullAuth);

  router.get('/alerts', (_req, res) => {
    const { active, resolved } = db.listAlerts();
    renderPage(res, {
      title: 'Meldingen',
      body: alertsPage({
        csrf: res.locals.auth!.session.csrf_token,
        active,
        resolved,
        siteNames: new Map(store.list().map((s) => [s.id, s.name])),
        webhookConfigured: ctx.notifier.enabled,
      }),
    });
  });

  router.post('/alerts/:id/ack', requireCsrf, (req, res) => {
    const actor = res.locals.auth!.user.email;
    const alert = acknowledgeAlert(db, Number(req.params.id), actor);
    if (alert) db.audit(actor, 'alert_acknowledged', alert.site_id, { alert: alert.id, title: alert.title });
    res.redirect(303, safeBack(req.body?.back, '/alerts'));
  });

  router.post('/settings/alerts/test', requireCsrf, async (_req, res: Response) => {
    const auth = res.locals.auth!;
    const result = await ctx.notifier.sendTest();
    db.audit(auth.user.email, 'alert_webhook_tested', null, { ok: result.ok });
    renderPage(res, {
      title: 'Instellingen',
      flash: { kind: result.ok ? 'ok' : 'error', message: result.message },
      body: settingsPage({
        csrf: auth.session.csrf_token,
        email: auth.user.email,
        ingestLastSeen: db.lastSnapshotReceivedAt(),
        webhookConfigured: ctx.notifier.enabled,
        staleHours: ctx.env.ALERT_STALE_HOURS,
      }),
    });
  });

  router.get('/vulnerabilities', (_req, res) => {
    const sites = store.list();
    const snapshots = db.latestSnapshots();
    const rows: FleetFindingRow[] = [];
    let scanned = 0;
    let lastScan: string | undefined;
    for (const site of sites) {
      const own = snapshots.filter((s) => s.site_id === site.id);
      const vulns = latestVulnerabilities(own);
      if (!vulns?.data) continue;
      scanned += 1;
      if (!lastScan || vulns.collectedAt > lastScan) lastScan = vulns.collectedAt;
      const updates = latestUpdates(own)?.data;
      for (const finding of vulns.data.findings) rows.push({ site, finding, updates });
    }
    const rank = (r: FleetFindingRow) => SEVERITY_ORDER.indexOf(worstSeverity(r.finding.vulnerabilities));
    rows.sort((a, b) => rank(a) - rank(b) || b.finding.vulnerabilities.length - a.finding.vulnerabilities.length);
    renderPage(res, { title: 'Kwetsbaarheden', body: vulnerabilitiesPage({ rows, scanned, total: sites.length, lastScan }) });
  });

  /** Live scan of one site, stored as a snapshot in the same shape n8n delivers. */
  router.post('/sites/:id/vulnerabilities/refresh', requireCsrf, async (req, res) => {
    const site = store.load().find((s) => s.id === req.params.id);
    if (!site) return res.redirect(303, '/');
    const stored = store.list().find((s) => s.id === site.id)!;
    if (!site.available) {
      return renderSiteDetail(ctx, res, stored, { kind: 'error', message: site.unavailableReason ?? 'site is niet beschikbaar' }, 422);
    }
    let ok = true;
    try {
      const data = await scanSite(clientFor(ctx, site), site, ctx.vulnerabilities);
      db.insertSnapshot(site.id, VULN_KIND, vulnerabilitySnapshotPayload(site.id, { data }), new Date().toISOString());
    } catch (err) {
      ok = false;
      const message = sanitizeMessage(err instanceof Error ? err.message : String(err));
      db.insertSnapshot(site.id, VULN_KIND, vulnerabilitySnapshotPayload(site.id, { error: message }), new Date().toISOString());
    }
    await evaluateAndNotify(ctx, VULN_KIND, [site.id]);
    db.audit(res.locals.auth!.user.email, 'vulnerabilities_scanned', site.id, { ok });
    res.redirect(303, `/sites/${site.id}?scanned=1#vulnerabilities`);
  });

  return router;
}
