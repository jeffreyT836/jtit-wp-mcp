import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { siteConfigSchema } from '../../src/config/schema.js';
import { DashboardDb } from '../../src/dashboard/db.js';
import { summarizeSite } from '../../src/dashboard/snapshots.js';
import { SiteStore } from '../../src/store/site-store.js';
import { latestVulnerabilities, VULN_KIND } from '../../src/vuln/items.js';
import { collectInstalled, matchVulnerabilities, pluginSlug, scanSite } from '../../src/vuln/scan.js';
import { runVulnerabilityCycle } from '../../src/vuln/scheduler.js';
import { WordfenceFeed } from '../../src/vuln/wordfence.js';
import { WpClient } from '../../src/wp/client.js';
import { createMockFetch, jsonResponse, makeSite } from '../helpers/harness.js';
import { wordfenceFetch } from './fixtures.js';

const silent = () => undefined;

/** Fake WordPress with core 6.8.2, Contact Form 7 5.8.1, Akismet 5.3, Hello Dolly and Astra 4.6.0. */
function fakeWp(opts: { bridge?: boolean; pluginsStatus?: number } = {}) {
  return createMockFetch((url) => {
    const p = new URL(url).pathname;
    if (p.endsWith('/nb-mcp/v1/status')) {
      return opts.bridge === false
        ? jsonResponse({ code: 'rest_no_route', message: 'No route' }, { status: 404 })
        : jsonResponse({ bridge_version: '1.2.0', wp_version: '6.8.2' });
    }
    if (p.endsWith('/wp/v2/plugins')) {
      if (opts.pluginsStatus) return jsonResponse({ code: 'rest_forbidden', message: 'Sorry, nope.' }, { status: opts.pluginsStatus });
      return jsonResponse([
        { plugin: 'contact-form-7/wp-contact-form-7', name: 'Contact Form 7', version: '5.8.1', status: 'active' },
        { plugin: 'akismet/akismet', name: 'Akismet Anti-spam', version: '5.3', status: 'active' },
        { plugin: 'hello', name: 'Hello Dolly', version: '1.7.2', status: 'inactive' },
        { plugin: 'no-version/no-version', name: 'Broken' },
      ]);
    }
    if (p.endsWith('/wp/v2/themes')) {
      return jsonResponse([{ stylesheet: 'astra', name: { rendered: 'Astra' }, version: '4.6.0', status: 'active' }]);
    }
    return jsonResponse({}, { status: 404 });
  });
}

async function loadedFeed(): Promise<WordfenceFeed> {
  const feed = new WordfenceFeed({ apiKey: 'k'.repeat(20), fetch: wordfenceFetch().fetch, log: silent });
  await feed.refresh();
  return feed;
}

const site = makeSite({ id: 'klant-a', password: 'secret pass' });

describe('vulnerability scan', () => {
  let db: DashboardDb;
  beforeEach(() => {
    db = new DashboardDb(':memory:');
  });
  afterEach(() => db.close());

  it('derives plugin slugs from plugin ids', () => {
    expect(pluginSlug('akismet/akismet.php')).toBe('akismet');
    expect(pluginSlug('contact-form-7/wp-contact-form-7')).toBe('contact-form-7');
    expect(pluginSlug('hello.php')).toBe('hello');
  });

  it('collects core, plugins and themes', async () => {
    const installed = await collectInstalled(new WpClient(site, { fetch: fakeWp() }));
    expect(installed).toEqual([
      { type: 'core', slug: 'wordpress', name: 'WordPress', version: '6.8.2' },
      { type: 'plugin', slug: 'contact-form-7', name: 'Contact Form 7', version: '5.8.1' },
      { type: 'plugin', slug: 'akismet', name: 'Akismet Anti-spam', version: '5.3' },
      { type: 'plugin', slug: 'hello', name: 'Hello Dolly', version: '1.7.2' },
      { type: 'theme', slug: 'astra', name: 'Astra', version: '4.6.0' },
    ]);
  });

  it('falls back to the last known WordPress version without a bridge', async () => {
    const installed = await collectInstalled(new WpClient(site, { fetch: fakeWp({ bridge: false }) }), '6.7.1');
    expect(installed[0]).toEqual({ type: 'core', slug: 'wordpress', name: 'WordPress', version: '6.7.1' });
    const none = await collectInstalled(new WpClient({ ...site, bridge: false }, { fetch: fakeWp() }));
    expect(none.some((s) => s.type === 'core')).toBe(false);
  });

  it('matches installed versions against the feed, skipping informational records', async () => {
    const feed = await loadedFeed();
    const items = matchVulnerabilities(await collectInstalled(new WpClient(site, { fetch: fakeWp() })), feed);
    expect(items.map((i) => [i.softwareType, i.slug, i.id])).toEqual([
      ['core', 'wordpress', 'a1b2c3d4-0000-4000-8000-000000000003'],
      ['plugin', 'contact-form-7', '848ccbdc-c6f1-480f-a272-cd459e706713'],
      ['theme', 'astra', 'a1b2c3d4-0000-4000-8000-000000000002'],
    ]);
    expect(items[1]).toEqual({
      id: '848ccbdc-c6f1-480f-a272-cd459e706713',
      title: 'Contact Form 7 <= 5.8.1 - Reflected Cross-Site Scripting',
      softwareType: 'plugin', slug: 'contact-form-7', softwareName: 'Contact Form 7', installedVersion: '5.8.1',
      cve: 'CVE-2024-1234', cvssScore: 8.1, cvssRating: 'High', patched: true, patchedVersions: ['5.8.2'],
      remediation: 'Update to version 5.8.2, or a newer patched version',
      reference: 'https://www.wordfence.com/threat-intel/vulnerabilities/id/848ccbdc-c6f1-480f-a272-cd459e706713?source=api-prod',
      published: '2024-01-09 00:00:00',
    });
  });

  it('stores a successful scan and summarises it', async () => {
    const feed = await loadedFeed();
    const outcome = await scanSite(new WpClient(site, { fetch: fakeWp() }), site.id, { db, feed, now: () => new Date('2026-10-16T06:05:00Z') });
    expect(outcome.ok).toBe(true);
    const snapshots = db.latestSnapshots(site.id);
    expect(snapshots.map((s) => s.kind)).toEqual([VULN_KIND]);
    expect(JSON.parse(snapshots[0]!.data)).toMatchObject({ site: 'klant-a', ok: true, data: { scannedAt: '2026-10-16T06:05:00.000Z' } });
    expect(summarizeSite(snapshots).vulnerabilities).toEqual({ total: 3, critical: 1 });
  });

  it('keeps the previous items when a later scan fails', async () => {
    const feed = await loadedFeed();
    await scanSite(new WpClient(site, { fetch: fakeWp() }), site.id, { db, feed, now: () => new Date('2026-10-16T06:00:00Z') });
    const failed = await scanSite(new WpClient(site, { fetch: fakeWp({ pluginsStatus: 403 }) }), site.id, { db, feed, now: () => new Date('2026-10-16T12:00:00Z') });
    expect(failed).toEqual({ ok: false, error: 'Kwetsbaarhedenscan mislukt: Sorry, nope.' });
    const latest = latestVulnerabilities(db.latestSnapshots(site.id))!;
    expect(latest.error).toBe('Kwetsbaarhedenscan mislukt: Sorry, nope.');
    expect(latest.collectedAt).toBe('2026-10-16T12:00:00.000Z');
    expect(latest.data?.items).toHaveLength(3);
    expect(summarizeSite(db.latestSnapshots(site.id))).toMatchObject({
      vulnerabilities: { total: 3, critical: 1 },
      vulnerabilitiesError: 'Kwetsbaarhedenscan mislukt: Sorry, nope.',
    });
  });

  it('reads broken snapshots defensively', () => {
    db.insertSnapshot(site.id, VULN_KIND, '{not json', '2026-10-16T00:00:00Z');
    expect(latestVulnerabilities(db.latestSnapshots(site.id))).toEqual({ collectedAt: '2026-10-16T00:00:00Z', error: 'ongeldige data' });
    db.insertSnapshot(site.id, VULN_KIND, JSON.stringify({ ok: false }), '2026-10-16T01:00:00Z');
    expect(latestVulnerabilities(db.latestSnapshots(site.id))?.error).toBe('Kwetsbaarhedenscan mislukt');
    expect(latestVulnerabilities([])).toBeUndefined();
  });
});

describe('runVulnerabilityCycle', () => {
  let db: DashboardDb;
  let store: SiteStore;
  beforeEach(() => {
    db = new DashboardDb(':memory:');
    store = new SiteStore(':memory:', randomBytes(32));
    const config = (id: string) => siteConfigSchema.parse({ id, name: id, url: `https://${id}.example.com`, username: 'mcp-bot' });
    store.upsert(config('klant-a'), 'pass a');
    store.upsert(config('klant-b'), 'pass b');
    store.upsert(config('zonder-wachtwoord'));
  });
  afterEach(() => {
    db.close();
    store.close();
  });

  it('refreshes the feed and scans every site with a password', async () => {
    const wf = wordfenceFetch();
    const feed = new WordfenceFeed({ apiKey: 'k'.repeat(20), fetch: wf.fetch, log: silent });
    const fetch = fakeWp();
    const result = await runVulnerabilityCycle({ db, store, feed, clientFor: (s) => new WpClient(s, { fetch }) });
    expect(result).toEqual({ scanned: 2, failed: 0 });
    expect(wf.calls).toHaveLength(1);
    expect(db.latestSnapshots('klant-a').map((s) => s.kind)).toEqual([VULN_KIND]);
    expect(db.latestSnapshots('zonder-wachtwoord')).toEqual([]);
    // Second cycle: feed is fresh, so no new download.
    await runVulnerabilityCycle({ db, store, feed, clientFor: (s) => new WpClient(s, { fetch }) });
    expect(wf.calls).toHaveLength(1);
  });

  it('counts failed scans', async () => {
    const feed = await loadedFeed();
    const fetch = fakeWp({ pluginsStatus: 500 });
    expect(await runVulnerabilityCycle({ db, store, feed, clientFor: (s) => new WpClient(s, { fetch }), concurrency: 1 })).toEqual({ scanned: 2, failed: 2 });
  });

  it('does nothing when disabled or when the feed cannot be loaded', async () => {
    const clientFor = (s: Parameters<typeof WpClient.prototype.constructor>[0]) => new WpClient(s, { fetch: fakeWp() });
    expect(await runVulnerabilityCycle({ db, store, feed: new WordfenceFeed({ log: silent }), clientFor })).toEqual({ scanned: 0, failed: 0 });
    const broken = new WordfenceFeed({ apiKey: 'k'.repeat(20), fetch: wordfenceFetch({ status: 429 }).fetch, log: silent });
    expect(await runVulnerabilityCycle({ db, store, feed: broken, clientFor })).toEqual({ scanned: 0, failed: 0 });
    expect(db.latestSnapshots()).toEqual([]);
  });
});
