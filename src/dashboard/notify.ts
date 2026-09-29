import type { FetchLike } from '../wp/client.js';
import { sanitizeMessage } from '../wp/errors.js';
import type { AlertChange } from './alerts.js';
import type { AlertRow } from './db.js';

const WEBHOOK_TIMEOUT_MS = 10_000;

export interface AlertNotifierOptions {
  /** `ALERT_WEBHOOK_URL`; notifications are off when unset. */
  url?: string;
  /** `ALERT_WEBHOOK_TOKEN`, sent as `Authorization: Bearer …` (e.g. for an n8n Webhook with header auth). */
  token?: string;
  /** `DASHBOARD_PUBLIC_URL`, used for links in the message. */
  publicUrl?: string;
  fetch?: FetchLike;
  /** Site display name for an id. */
  siteName?: (siteId: string) => string | undefined;
  log?: (line: string) => void;
}

export interface WebhookAlert {
  id: number;
  site: string | null;
  siteName: string | null;
  type: string;
  severity: string;
  title: string;
  details: unknown;
  openedAt: string | null;
  resolvedAt: string | null;
  url: string | null;
}

export interface WebhookPayload {
  source: 'wp-fleet-dashboard';
  /** Slack/Mattermost/Google Chat-compatible summary. */
  text: string;
  opened: WebhookAlert[];
  resolved: WebhookAlert[];
  test?: true;
}

/**
 * Sends alert transitions to one webhook, batched per evaluation. The payload carries a
 * ready-to-post `text` (works as-is with a Slack incoming webhook) plus structured
 * `opened`/`resolved` lists for n8n (e.g. to send an e-mail). Delivery failures are logged,
 * never thrown: an unreachable webhook must not break an ingest.
 */
export class AlertNotifier {
  private readonly fetchImpl: FetchLike;
  private readonly log: (line: string) => void;

  constructor(private readonly options: AlertNotifierOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  get enabled(): boolean {
    return !!this.options.url;
  }

  private link(path: string): string | null {
    return this.options.publicUrl ? `${this.options.publicUrl.replace(/\/+$/, '')}${path}` : null;
  }

  private toWebhookAlert(alert: AlertRow): WebhookAlert {
    let details: unknown = null;
    try {
      details = alert.details ? JSON.parse(alert.details) : null;
    } catch {
      details = null;
    }
    return {
      id: alert.id,
      site: alert.site_id,
      siteName: alert.site_id ? (this.options.siteName?.(alert.site_id) ?? alert.site_id) : null,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      details,
      openedAt: alert.opened_at,
      resolvedAt: alert.resolved_at,
      url: this.link(alert.site_id ? `/sites/${alert.site_id}#alerts` : '/alerts'),
    };
  }

  buildPayload(changes: AlertChange[]): WebhookPayload {
    const opened = changes.filter((c) => c.change === 'opened').map((c) => this.toWebhookAlert(c.alert));
    const resolved = changes.filter((c) => c.change === 'resolved').map((c) => this.toWebhookAlert(c.alert));
    const where = (a: WebhookAlert) => (a.siteName ? `${a.siteName}: ` : '');
    const lines = [
      ...opened.map((a) => `${a.severity === 'critical' ? '🔴' : '🟠'} ${where(a)}${a.title}`),
      ...resolved.map((a) => `✅ Opgelost — ${where(a)}${a.title}`),
    ];
    const overview = this.link('/alerts');
    if (overview) lines.push(`Meldingen: ${overview}`);
    return { source: 'wp-fleet-dashboard', text: `WP Fleet\n${lines.join('\n')}`, opened, resolved };
  }

  /** Posts the transitions (if any); resolves to whether delivery succeeded. */
  async send(changes: AlertChange[]): Promise<boolean> {
    if (!this.enabled || changes.length === 0) return false;
    const result = await this.post(this.buildPayload(changes));
    if (!result.ok) this.log(`[wp-dashboard] alert webhook failed: ${result.message}`);
    return result.ok;
  }

  /** Test message from the settings page. */
  sendTest(): Promise<{ ok: boolean; message: string }> {
    if (!this.enabled) return Promise.resolve({ ok: false, message: 'ALERT_WEBHOOK_URL is niet ingesteld.' });
    return this.post({
      source: 'wp-fleet-dashboard',
      text: 'WP Fleet\nTestmelding vanuit het dashboard: de koppeling werkt.',
      opened: [],
      resolved: [],
      test: true,
    });
  }

  private async post(payload: WebhookPayload): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await this.fetchImpl(this.options.url!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, message: `webhook antwoordde met HTTP ${res.status}` };
      return { ok: true, message: 'Testmelding verstuurd.' };
    } catch (err) {
      // Never echo the URL: it can hold a secret (Slack webhook path).
      return { ok: false, message: `webhook niet bereikbaar: ${sanitizeMessage(err instanceof Error ? err.message : String(err)).replaceAll(this.options.url!, '<webhook>')}` };
    }
  }
}
