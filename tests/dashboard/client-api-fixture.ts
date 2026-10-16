import { siteConfigSchema } from '../../src/config/schema.js';
import type { DashboardDb } from '../../src/dashboard/db.js';
import { HEALTH_KIND } from '../../src/dashboard/health.js';
import type { SiteStore } from '../../src/store/site-store.js';
import { vulnSnapshotPayload, VULN_KIND } from '../../src/vuln/items.js';
import { matchVulnerabilities } from '../../src/vuln/scan.js';
import { WordfenceFeed } from '../../src/vuln/wordfence.js';
import { wordfenceFetch } from '../vuln/fixtures.js';

/** "Now" for the fixture fleet; every snapshot is recent relative to it. */
export const FIXTURE_NOW = new Date('2026-10-16T09:40:00.000Z');
const COLLECTED = '2026-10-16T09:00:00.000Z';
const SCANNED = '2026-10-16T06:05:00.000Z';

export async function fixtureFeed(): Promise<WordfenceFeed> {
  const feed = new WordfenceFeed({
    apiKey: 'k'.repeat(20), fetch: wordfenceFetch().fetch, now: () => Date.parse('2026-10-16T06:00:00.000Z'), log: () => undefined,
  });
  await feed.refresh();
  return feed;
}

const health = (site: string, opts: { wp: string; php: string }) => ({
  site, ok: true,
  data: { ok: true, roles: ['administrator'], bridge: 'ok', versions: { bridge_version: '1.2.0', wp_version: opts.wp, php_version: opts.php, multisite: false } },
});

/**
 * Three sites: `klant-a` critical (high CVSS vulnerability + core and plugin updates),
 * `klant-b` warning (theme update, medium vulnerability, Site Health issue), `klant-c` ok.
 */
export async function seedFixtureFleet(store: SiteStore, db: DashboardDb, feed: WordfenceFeed): Promise<void> {
  const add = (id: string, name: string, tags: string[]) =>
    store.upsert(siteConfigSchema.parse({ id, name, url: `https://${id}.nl`, username: 'mcp-bot', tags }), 'app pass 1234');
  add('klant-a', 'Klant A', ['klant']);
  add('klant-b', 'Klant B Webshop', ['klant', 'woocommerce']);
  add('klant-c', 'JTIT', ['intern']);

  // klant-a: WordPress 6.8.2 + Contact Form 7 5.8.1 (CVE, CVSS 8.1) + updates.
  db.insertSnapshot('klant-a', 'fleet_health', JSON.stringify(health('klant-a', { wp: '6.8.2', php: '8.3.12' })), COLLECTED);
  db.insertSnapshot('klant-a', 'fleet_updates_report', JSON.stringify({
    site: 'klant-a', ok: true,
    data: {
      checked_at: COLLECTED,
      core: [{ current: '6.8.2', version: '6.8.3', response: 'upgrade', locale: 'nl_NL', type: 'minor' }, { current: '6.8.2', version: '6.8.2', response: 'latest' }],
      plugins: [
        { plugin: 'contact-form-7/wp-contact-form-7.php', name: 'Contact Form 7', current_version: '5.8.1', new_version: '6.0.1' },
        { plugin: 'hello.php', name: 'Hello Dolly', current_version: '1.7.1', new_version: '1.7.2' },
      ],
      themes: [],
      translations: { count: 0 },
    },
  }), COLLECTED);
  db.insertSnapshot('klant-a', HEALTH_KIND, JSON.stringify({ site: 'klant-a', ok: true, data: { summary: { critical: 0, recommended: 2, good: 18 }, tests: [], info: {} } }), COLLECTED);
  const itemsA = matchVulnerabilities([
    { type: 'core', slug: 'wordpress', name: 'WordPress', version: '6.8.2' },
    { type: 'plugin', slug: 'contact-form-7', name: 'Contact Form 7', version: '5.8.1' },
  ], feed);
  db.insertSnapshot('klant-a', VULN_KIND, vulnSnapshotPayload('klant-a', { data: { scannedAt: SCANNED, items: itemsA } }), SCANNED);

  // klant-b: Astra 4.6.0 (medium vulnerability, theme update), one critical Site Health test.
  db.insertSnapshot('klant-b', 'fleet_health', JSON.stringify(health('klant-b', { wp: '6.8.3', php: '8.2.20' })), COLLECTED);
  db.insertSnapshot('klant-b', 'fleet_updates_report', JSON.stringify({
    site: 'klant-b', ok: true,
    data: {
      checked_at: COLLECTED,
      core: [{ current: '6.8.3', version: '6.8.3', response: 'latest' }],
      plugins: [],
      themes: [{ stylesheet: 'astra', name: 'Astra', current_version: '4.6.0', new_version: '4.8.1' }],
    },
  }), COLLECTED);
  db.insertSnapshot('klant-b', HEALTH_KIND, JSON.stringify({ site: 'klant-b', ok: true, data: { summary: { critical: 1, recommended: 3, good: 16 }, tests: [], info: {} } }), COLLECTED);
  const itemsB = matchVulnerabilities([{ type: 'theme', slug: 'astra', name: 'Astra', version: '4.6.0' }], feed);
  db.insertSnapshot('klant-b', VULN_KIND, vulnSnapshotPayload('klant-b', { data: { scannedAt: SCANNED, items: itemsB } }), SCANNED);

  // klant-c: everything up to date and clean.
  db.insertSnapshot('klant-c', 'fleet_health', JSON.stringify(health('klant-c', { wp: '6.8.3', php: '8.3.12' })), COLLECTED);
  db.insertSnapshot('klant-c', 'fleet_updates_report', JSON.stringify({
    site: 'klant-c', ok: true, data: { checked_at: COLLECTED, core: [{ current: '6.8.3', version: '6.8.3', response: 'latest' }], plugins: [], themes: [] },
  }), COLLECTED);
  db.insertSnapshot('klant-c', HEALTH_KIND, JSON.stringify({ site: 'klant-c', ok: true, data: { summary: { critical: 0, recommended: 0, good: 20 }, tests: [], info: {} } }), COLLECTED);
  db.insertSnapshot('klant-c', VULN_KIND, vulnSnapshotPayload('klant-c', { data: { scannedAt: SCANNED, items: [] } }), SCANNED);

  // A fleet-wide row must never show up as a site.
  db.insertSnapshot(null, 'fleet_health', JSON.stringify({ results: [] }), COLLECTED);
}
