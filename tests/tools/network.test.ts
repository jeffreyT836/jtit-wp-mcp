import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, createMockFetch, jsonResponse, makeSite, type Harness } from '../helpers/harness.js';

function textOf(result: Awaited<ReturnType<Harness['client']['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

const HEALTH = {
  checked_at: '2026-09-28T10:00:00Z',
  summary: { critical: 1, recommended: 2, good: 10 },
  tests: [{ test: 'php_version', label: 'PHP is verouderd', status: 'critical', badge: { label: 'Prestaties', color: 'blue' }, description: 'x', actions: [] }],
  info: { wp_version: '6.8.3' },
};

describe('tools/network + site health', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('get_site_health returns the bridge report and refuses an old bridge clearly', async () => {
    const calls: string[] = [];
    harness = await createHarness({
      sites: [makeSite({ id: 'new' }), makeSite({ id: 'old' })],
      fetch: createMockFetch((url) => {
        calls.push(url);
        const old = url.includes('old.example.com');
        if (url.includes('/nb-mcp/v1/status')) return jsonResponse(old ? { bridge_version: '1.1.0', features: ['safe_updates'] } : { bridge_version: '1.2.0', features: ['safe_updates', 'site_health', 'network'] });
        if (url.includes('/nb-mcp/v1/site-health')) return jsonResponse(HEALTH);
        throw new Error(`unexpected ${url}`);
      }),
    });
    const ok = await harness.client.callTool({ name: 'get_site_health', arguments: { site: 'new', include_sizes: true } });
    expect(JSON.parse(textOf(ok))).toMatchObject({ summary: { critical: 1 } });
    expect(calls.some((u) => u.includes('site-health') && u.includes('include_sizes=1'))).toBe(true);

    const old = await harness.client.callTool({ name: 'get_site_health', arguments: { site: 'old' } });
    expect(old.isError).toBe(true);
    expect(textOf(old)).toMatch(/1\.1\.0.*1\.2\.0/);
    expect(calls.some((u) => u.includes('old.example.com') && u.includes('site-health'))).toBe(false);
  });

  it('fleet_site_health totals critical/recommended and skips sites without the bridge', async () => {
    harness = await createHarness({
      sites: [makeSite({ id: 'a' }), makeSite({ id: 'b' }), makeSite({ id: 'nobridge', bridge: false })],
      fetch: createMockFetch((url) => {
        if (url.includes('b.example.com')) return jsonResponse({ code: 'rest_no_route', message: 'no' }, { status: 404 });
        if (url.includes('/nb-mcp/v1/status')) return jsonResponse({ features: ['site_health'] });
        if (url.includes('/nb-mcp/v1/site-health')) return jsonResponse(HEALTH);
        throw new Error(`unexpected ${url}`);
      }),
    });
    const data = JSON.parse(textOf(await harness.client.callTool({ name: 'fleet_site_health', arguments: {} })));
    expect(data.summary).toEqual({ sites: 2, critical: 1, recommended: 2, failed: 1, skipped: 1 });
    expect(data.results.find((r: { site: string }) => r.site === 'a')).toMatchObject({ ok: true, data: { summary: { good: 10 } } });
  });

  it('list_network_sites and get_network_site go through the bridge', async () => {
    const calls: string[] = [];
    harness = await createHarness({
      sites: [makeSite({ id: 'net' })],
      fetch: createMockFetch((url) => {
        calls.push(new URL(url).pathname);
        if (url.includes('/nb-mcp/v1/status')) return jsonResponse({ features: ['network'], multisite: true });
        if (url.includes('/nb-mcp/v1/network/sites/3')) return jsonResponse({ blog_id: 3, name: 'Drie' });
        if (url.includes('/nb-mcp/v1/network/sites')) return jsonResponse({ multisite: true, total: 1, sites: [{ blog_id: 3, name: 'Drie' }] });
        throw new Error(`unexpected ${url}`);
      }),
    });
    const list = JSON.parse(textOf(await harness.client.callTool({ name: 'list_network_sites', arguments: { site: 'net' } })));
    expect(list.sites[0].name).toBe('Drie');
    const one = JSON.parse(textOf(await harness.client.callTool({ name: 'get_network_site', arguments: { site: 'net', blog_id: 3 } })));
    expect(one).toEqual({ blog_id: 3, name: 'Drie' });
    const bad = await harness.client.callTool({ name: 'get_network_site', arguments: { site: 'net', blog_id: -1 } });
    expect(bad.isError).toBe(true);
    expect(calls.filter((p) => p.includes('/network/sites/-1'))).toEqual([]);
  });
});
