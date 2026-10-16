import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/wp/client.js';
import { compactRecord, WordfenceFeed } from '../../src/vuln/wordfence.js';
import { FEED, wordfenceFetch } from './fixtures.js';

const KEY = 'wf-secret-key-1234567890';
const silent = () => undefined;

describe('compactRecord', () => {
  it('keeps only the fields the client API needs, one entry per software', () => {
    const [entry] = compactRecord(FEED['848ccbdc-c6f1-480f-a272-cd459e706713']);
    expect(entry).toEqual({
      id: '848ccbdc-c6f1-480f-a272-cd459e706713',
      title: 'Contact Form 7 <= 5.8.1 - Reflected Cross-Site Scripting',
      type: 'plugin', slug: 'contact-form-7', name: 'Contact Form 7',
      ranges: [{ from_version: '*', from_inclusive: true, to_version: '5.8.1', to_inclusive: true }],
      patched: true, patchedVersions: ['5.8.2'], remediation: 'Update to version 5.8.2, or a newer patched version',
      informational: false, cve: 'CVE-2024-1234', cvssScore: 8.1, cvssRating: 'High',
      reference: 'https://www.wordfence.com/threat-intel/vulnerabilities/id/848ccbdc-c6f1-480f-a272-cd459e706713?source=api-prod',
      published: '2024-01-09 00:00:00',
    });
  });

  it('ignores malformed records and unknown software types', () => {
    expect(compactRecord(null)).toEqual([]);
    expect(compactRecord({ id: 'x' })).toEqual([]);
    expect(compactRecord({ id: 'x', software: [{ type: 'library', slug: 'y' }, { type: 'plugin' }] })).toEqual([]);
    const [minimal] = compactRecord({ id: 'x', software: [{ type: 'plugin', slug: 'y', affected_versions: { a: { from_version: 1 } } }] });
    expect(minimal).toMatchObject({ title: 'x', name: 'y', ranges: [], patchedVersions: [], cvssScore: null, reference: null });
  });
});

describe('WordfenceFeed', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('is disabled without an API key and never fetches', async () => {
    const wf = wordfenceFetch();
    const feed = new WordfenceFeed({ fetch: wf.fetch, log: silent });
    expect(feed.enabled).toBe(false);
    expect(feed.isDue()).toBe(false);
    expect(await feed.refresh()).toBe(false);
    expect(feed.loadCache()).toBe(false);
    expect(wf.calls).toHaveLength(0);
    expect(feed.status()).toEqual({ enabled: false, source: 'wordfence-intelligence-v3-production', updatedAt: null, records: null, error: null });
  });

  it('downloads the streamed feed with a bearer key, indexes it and persists the index', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wf-'));
    const cacheFile = join(dir, 'sub', 'wordfence-index.json');
    const wf = wordfenceFetch({ chunkSize: 1 });
    const now = Date.parse('2026-10-16T06:00:00Z');
    const feed = new WordfenceFeed({ apiKey: KEY, feed: 'scanner', cacheFile, fetch: wf.fetch, now: () => now, log: silent });
    expect(feed.isDue()).toBe(true);
    expect(await feed.refreshIfDue()).toBe(true);
    expect(wf.calls).toEqual([{ url: 'https://www.wordfence.com/api/intelligence/v3/vulnerabilities/scanner', auth: `Bearer ${KEY}` }]);
    expect(feed.status()).toEqual({
      enabled: true, source: 'wordfence-intelligence-v3-scanner', updatedAt: '2026-10-16T06:00:00.000Z', records: 5, error: null,
    });
    expect(feed.lookup('plugin', 'contact-form-7')).toHaveLength(2);
    expect(feed.lookup('core', 'anything')).toHaveLength(1);
    expect(feed.lookup('theme', 'missing')).toEqual([]);
    expect(feed.isDue()).toBe(false);
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(cacheFile, 'utf8')).not.toContain(KEY);

    // A restart loads the cache instead of downloading again.
    const again = wordfenceFetch();
    const restarted = new WordfenceFeed({ apiKey: KEY, feed: 'scanner', cacheFile, fetch: again.fetch, now: () => now + 3_600_000, log: silent });
    expect(restarted.loadCache()).toBe(true);
    expect(restarted.hasData()).toBe(true);
    expect(restarted.isDue()).toBe(false);
    expect(restarted.lookup('theme', 'astra')).toHaveLength(1);
    expect(again.calls).toHaveLength(0);

    // A cache of another feed is ignored; a corrupt cache is ignored too.
    expect(new WordfenceFeed({ apiKey: KEY, feed: 'production', cacheFile, log: silent }).loadCache()).toBe(false);
    writeFileSync(cacheFile, '{nope');
    expect(new WordfenceFeed({ apiKey: KEY, feed: 'scanner', cacheFile, log: silent }).loadCache()).toBe(false);
  });

  it('is due again after the refresh interval', async () => {
    let now = Date.parse('2026-10-16T00:00:00Z');
    const feed = new WordfenceFeed({ apiKey: KEY, refreshHours: 12, fetch: wordfenceFetch().fetch, now: () => now, log: silent });
    await feed.refresh();
    now += 11 * 3_600_000;
    expect(feed.isDue()).toBe(false);
    now += 2 * 3_600_000;
    expect(feed.isDue()).toBe(true);
  });

  it('shares one download between concurrent refreshes', async () => {
    const wf = wordfenceFetch();
    const feed = new WordfenceFeed({ apiKey: KEY, fetch: wf.fetch, log: silent });
    await Promise.all([feed.refresh(), feed.refresh()]);
    expect(wf.calls).toHaveLength(1);
  });

  it.each([
    [401, 'Wordfence weigert de API-sleutel (HTTP 401)'],
    [403, 'Wordfence weigert de API-sleutel (HTTP 403)'],
    [429, 'Wordfence-limiet bereikt (HTTP 429)'],
    [500, 'Wordfence-feed ophalen mislukt (HTTP 500)'],
  ])('reports HTTP %i in Dutch, keeps old data and backs off', async (status, message) => {
    let now = Date.parse('2026-10-16T00:00:00Z');
    let fail = false;
    const ok = wordfenceFetch();
    const bad = wordfenceFetch({ status, body: '{"message":"nope"}' });
    const fetch = ((input: string, init?: RequestInit) => (fail ? bad.fetch(input, init) : ok.fetch(input, init))) as FetchLike;
    const feed = new WordfenceFeed({ apiKey: KEY, refreshHours: 1, fetch, now: () => now, log: silent });
    await feed.refresh();
    fail = true;
    now += 2 * 3_600_000;
    expect(await feed.refreshIfDue()).toBe(false);
    expect(feed.status().error).toContain(message);
    expect(feed.status().records).toBe(5);
    expect(feed.lookup('theme', 'astra')).toHaveLength(1);
    expect(feed.isDue()).toBe(false); // back-off after a failure
    now += 61 * 60_000;
    expect(feed.isDue()).toBe(true);
    fail = false;
    expect(await feed.refresh()).toBe(true);
    expect(feed.status().error).toBeNull();
  });

  it('never leaks the API key in errors or logs', async () => {
    const logs: string[] = [];
    const fetch = (async () => {
      throw new Error(`connect ECONNREFUSED (Authorization: Bearer ${KEY})`);
    }) as unknown as FetchLike;
    const feed = new WordfenceFeed({ apiKey: KEY, fetch, log: (m) => logs.push(m) });
    expect(await feed.refresh()).toBe(false);
    const error = feed.status().error!;
    expect(error).toContain('Wordfence-feed niet bereikbaar');
    expect(error).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('reports an unreadable feed', async () => {
    const feed = new WordfenceFeed({ apiKey: KEY, fetch: wordfenceFetch({ body: '{"a": {"b": ' }).fetch, log: silent });
    expect(await feed.refresh()).toBe(false);
    expect(feed.status().error).toContain('Wordfence-feed onleesbaar');
    expect(feed.hasData()).toBe(false);
  });
});
