import { afterEach, describe, expect, it } from 'vitest';
import {
  isAffected,
  pluginSlug,
  versionCompare,
  VulnerabilityDb,
  WPVULNERABILITY_API,
  type SiteVulnerabilityReport,
} from '../../src/wp/vulnerabilities.js';
import { createHarness, createMockFetch, jsonResponse, makeSite, type Harness } from '../helpers/harness.js';

const cf7Vulns = {
  error: 0,
  data: {
    name: 'Contact Form 7',
    vulnerability: [
      {
        uuid: 'v-high',
        name: 'Contact Form 7 < 5.8.4 - Unrestricted File Upload',
        operator: { min_version: null, min_operator: null, max_version: '5.8.4', max_operator: 'lt', unfixed: '0', closed: '0' },
        source: [{ id: 'CVE-2023-6449', name: 'CVE-2023-6449', link: 'https://www.cve.org/CVERecord?id=CVE-2023-6449' }, { id: 'x', link: 'javascript:alert(1)' }],
        impact: { cvss: { score: '7.2', severity: 'h' } },
      },
      {
        uuid: 'v-old',
        name: 'Contact Form 7 <= 5.0 - XSS',
        operator: { max_version: '5.0', max_operator: 'le', unfixed: '0' },
        impact: { cvss: { score: '6.1' } },
      },
      {
        uuid: 'v-range',
        name: 'Contact Form 7 5.5 - 5.9 - <b>Open Redirect</b>',
        operator: { min_version: '5.5', min_operator: 'ge', max_version: '5.9', max_operator: 'le', unfixed: '1' },
        impact: {},
      },
    ],
  },
};

function fakeFleet(opts: { vulnStatus?: number } = {}) {
  const lookups: string[] = [];
  const fetch = createMockFetch((url) => {
    if (url.startsWith(WPVULNERABILITY_API)) {
      lookups.push(url.slice(WPVULNERABILITY_API.length));
      if (opts.vulnStatus) return jsonResponse({}, { status: opts.vulnStatus });
      if (url.endsWith('/plugin/contact-form-7/')) return jsonResponse(cf7Vulns);
      if (url.endsWith('/plugin/akismet/')) return jsonResponse({ error: 0, data: { vulnerability: [] } });
      if (url.endsWith('/theme/twentytwenty/')) return jsonResponse({ error: 1, message: 'not found', data: null });
      if (url.endsWith('/core/6.4.1/')) {
        return jsonResponse({ error: 0, data: { vulnerability: [{ uuid: 'core-1', name: 'WP < 6.4.2 - POP chain', impact: { cvss: { severity: 'c' } } }] } });
      }
      return jsonResponse({}, { status: 404 });
    }
    const path = new URL(url).pathname;
    if (path.endsWith('/wp/v2/plugins')) {
      return jsonResponse([
        { plugin: 'contact-form-7/wp-contact-form-7', name: 'Contact Form 7', version: '5.8', status: 'active' },
        { plugin: 'akismet/akismet', name: 'Akismet', version: '5.3', status: 'inactive' },
        { plugin: '../evil/x', name: 'Evil', version: '1.0', status: 'active' },
      ]);
    }
    if (path.endsWith('/wp/v2/themes')) return jsonResponse([{ stylesheet: 'twentytwenty', name: { rendered: 'Twenty Twenty' }, version: '2.0', status: 'active' }]);
    if (path.endsWith('/nb-mcp/v1/status')) return jsonResponse({ bridge_version: '1.2.0', wp_version: '6.4.1' });
    return jsonResponse({ code: 'rest_no_route', message: 'nope' }, { status: 404 });
  });
  return { fetch, lookups };
}

describe('versionCompare (PHP version_compare)', () => {
  it.each([
    ['1.0', '1.0', 0],
    ['1.0', '1.0.0', -1],
    ['1.10', '1.9', 1],
    ['5.8.4', '5.8.10', -1],
    ['1.0rc1', '1.0', -1],
    ['1.0-beta', '1.0-alpha', 1],
    ['1.0.0-dev', '1.0.0', -1],
    ['2.0', '1.99.99', 1],
  ])('%s vs %s → %i', (a, b, expected) => {
    expect(versionCompare(a, b)).toBe(expected);
  });

  it('applies min/max operator ranges', () => {
    const range = { min_version: '5.5', min_operator: 'ge', max_version: '5.9', max_operator: 'le' };
    expect(isAffected('5.5', range)).toBe(true);
    expect(isAffected('5.9', range)).toBe(true);
    expect(isAffected('5.9.1', range)).toBe(false);
    expect(isAffected('5.4', range)).toBe(false);
    expect(isAffected('5.8.3', { max_version: '5.8.4', max_operator: 'lt' })).toBe(true);
    expect(isAffected('5.8.4', { max_version: '5.8.4', max_operator: 'lt' })).toBe(false);
    expect(isAffected('1.0', null)).toBe(false);
    expect(isAffected('1.0', {})).toBe(false);
  });

  it('derives plugin slugs', () => {
    expect(pluginSlug('contact-form-7/wp-contact-form-7.php')).toBe('contact-form-7');
    expect(pluginSlug('hello.php')).toBe('hello');
  });
});

describe('VulnerabilityDb', () => {
  it('caches lookups, treats 404 as "nothing known" and does not cache failures', async () => {
    let calls = 0;
    let fail = true;
    const db = new VulnerabilityDb({
      fetch: createMockFetch((url) => {
        calls += 1;
        if (url.endsWith('/plugin/flaky/')) return fail ? jsonResponse({}, { status: 503 }) : jsonResponse(cf7Vulns);
        return jsonResponse({}, { status: 404 });
      }),
    });
    expect(await db.lookup('plugin', 'unknown-premium')).toEqual([]);
    expect(await db.lookup('plugin', 'unknown-premium')).toEqual([]);
    expect(calls).toBe(1);
    await expect(db.lookup('plugin', 'flaky')).rejects.toThrow(/HTTP 503/);
    fail = false;
    expect(await db.lookup('plugin', 'flaky')).toHaveLength(3);
    expect(calls).toBe(3);
  });

  it('refuses slugs and versions that are not plain identifiers', async () => {
    const db = new VulnerabilityDb({ fetch: createMockFetch(() => jsonResponse({})) });
    await expect(db.lookup('plugin', '../../etc')).rejects.toThrow(/ongeldige slug/);
    await expect(db.lookup('core', '6.4 1')).rejects.toThrow(/ongeldige versie/);
  });
});

describe('fleet_vulnerabilities', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('reports only vulnerabilities that apply to the installed versions', async () => {
    const { fetch, lookups } = fakeFleet();
    harness = await createHarness({ sites: [makeSite({ id: 'a' }), makeSite({ id: 'b', available: false, unavailableReason: 'geen wachtwoord' })], fetch });
    const result = await harness.client.callTool({ name: 'fleet_vulnerabilities', arguments: {} });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
      summary: Record<string, number>;
      results: Array<{ site: string; ok: boolean; data: SiteVulnerabilityReport }>;
    };
    expect(body.summary).toMatchObject({ sites: 1, vulnerableSites: 1, critical: 1, high: 1, unknown: 1, total: 3, skipped: 1 });
    const report = body.results[0]!.data;
    expect(report.checked).toEqual({ core: true, plugins: 2, themes: 1 });
    expect(report.errors).toEqual([]);
    // Core first (critical), then the plugin; v-old (≤ 5.0) does not apply to 5.8.
    expect(report.findings.map((f) => `${f.type}:${f.slug}`)).toEqual(['core:wordpress', 'plugin:contact-form-7']);
    const cf7 = report.findings[1]!;
    expect(cf7.vulnerabilities.map((v) => v.id)).toEqual(['v-high', 'v-range']);
    expect(cf7.vulnerabilities[0]).toMatchObject({ severity: 'high', score: 7.2, fixedIn: '5.8.4', unfixed: false, affected: '< 5.8.4' });
    expect(cf7.vulnerabilities[0]!.references).toEqual([{ name: 'CVE-2023-6449', url: 'https://www.cve.org/CVERecord?id=CVE-2023-6449' }]);
    expect(cf7.vulnerabilities[1]).toMatchObject({ severity: 'unknown', unfixed: true, name: 'Contact Form 7 5.5 - 5.9 - Open Redirect' });
    expect(cf7.vulnerabilities[1]!.fixedIn).toBeUndefined();
    // The malformed plugin id is never sent; nothing identifying the site is either.
    expect(lookups.sort()).toEqual(['/core/6.4.1/', '/plugin/akismet/', '/plugin/contact-form-7/', '/theme/twentytwenty/']);
  });

  it('filters by min_severity and reports lookup failures as unknown, not safe', async () => {
    const { fetch } = fakeFleet();
    harness = await createHarness({ sites: [makeSite({ id: 'a' })], fetch });
    const filtered = await harness.client.callTool({ name: 'fleet_vulnerabilities', arguments: { min_severity: 'high' } });
    const f = JSON.parse((filtered.content as Array<{ text: string }>)[0]!.text);
    expect(f.summary).toMatchObject({ critical: 1, high: 1, unknown: 0, total: 2 });

    const down = fakeFleet({ vulnStatus: 502 });
    await harness.close();
    harness = await createHarness({ sites: [makeSite({ id: 'a' })], fetch: down.fetch });
    const result = await harness.client.callTool({ name: 'fleet_vulnerabilities', arguments: {} });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].data.findings).toEqual([]);
    expect(body.results[0].data.errors).toHaveLength(4);
    expect(body.results[0].data.errors[0].error).toMatch(/HTTP 502/);
  });
});
