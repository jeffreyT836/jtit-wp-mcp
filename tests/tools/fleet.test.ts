import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, createMockFetch, jsonResponse, makeSite, type Harness } from '../helpers/harness.js';

function textOf(result: Awaited<ReturnType<Harness['client']['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe('tools/fleet', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('fleet_health reports per-site status and a summary, without failing the whole call', async () => {
    const siteA = makeSite({ id: 'a' });
    const siteB = makeSite({ id: 'b' });
    harness = await createHarness({
      sites: [siteA, siteB],
      fetch: createMockFetch((url) => {
        if (url.includes('a.example.com')) {
          if (url.includes('/wp/v2/users/me')) return jsonResponse({ id: 1, username: 'bot', roles: ['administrator'] });
          if (url.includes('/nb-mcp/v1/status')) return jsonResponse({ bridge_version: '1.0', wp_version: '6.5' });
        }
        if (url.includes('b.example.com')) {
          if (url.includes('/wp/v2/users/me')) return jsonResponse({ code: 'rest_forbidden', message: 'no' }, { status: 403 });
          if (url.includes('/nb-mcp/v1/status')) return jsonResponse({ code: 'rest_no_route', message: 'no' }, { status: 404 });
        }
        throw new Error(`unexpected url ${url}`);
      }),
    });

    const result = await harness.client.callTool({ name: 'fleet_health', arguments: {} });
    const data = JSON.parse(textOf(result));
    expect(data.summary).toEqual({ sites: 2, ok: 1, failed: 1, skipped: 0 });
    const bySite = Object.fromEntries(data.results.map((r: { site: string }) => [r.site, r]));
    expect(bySite.a).toMatchObject({ ok: true, data: { ok: true, bridge: 'ok' } });
    expect(bySite.b).toMatchObject({ ok: true, data: { ok: false, bridge: 'missing' } });
  });

  it('fleet_health honors an explicit sites filter', async () => {
    const siteA = makeSite({ id: 'a' });
    const siteB = makeSite({ id: 'b' });
    harness = await createHarness({
      sites: [siteA, siteB],
      fetch: createMockFetch(() => jsonResponse({ id: 1, roles: ['administrator'] })),
    });
    const result = await harness.client.callTool({ name: 'fleet_health', arguments: { sites: ['a'] } });
    const data = JSON.parse(textOf(result));
    expect(data.results).toHaveLength(1);
    expect(data.results[0].site).toBe('a');
  });

  it('fleet_health never contacts an unavailable site and reports it as skipped, even when named explicitly', async () => {
    const good = makeSite({ id: 'good' });
    const bad = makeSite({ id: 'bad', available: false, unavailableReason: 'missing secret', password: null });
    let contactedBad = false;
    harness = await createHarness({
      sites: [good, bad],
      fetch: createMockFetch((url) => {
        if (url.includes('bad.')) contactedBad = true;
        return jsonResponse({ id: 1, roles: ['administrator'] });
      }),
    });

    const result = await harness.client.callTool({
      name: 'fleet_health',
      arguments: { sites: ['good', 'bad'] },
    });
    const data = JSON.parse(textOf(result));

    expect(contactedBad).toBe(false);
    expect(data.summary).toMatchObject({ sites: 1, skipped: 1 });
    expect(data.results.map((r: { site: string }) => r.site)).toEqual(['good']);
    expect(data.skipped).toEqual([{ site: 'bad', reason: 'missing secret' }]);
  });

  it('fleet_updates_report summarizes pending counts and counts a bridge-missing site as failed', async () => {
    const siteA = makeSite({ id: 'a' });
    const siteB = makeSite({ id: 'b', bridge: false });
    harness = await createHarness({
      sites: [siteA, siteB],
      fetch: createMockFetch((url) => {
        if (url.includes('a.example.com')) {
          return jsonResponse({
            core: [{ current: '6.4', version: '6.5', response: 'upgrade' }],
            plugins: [{ plugin: 'akismet/akismet.php', current_version: '5.3', new_version: '5.4' }],
            themes: [],
          });
        }
        throw new Error(`unexpected url ${url}`);
      }),
    });

    const result = await harness.client.callTool({ name: 'fleet_updates_report', arguments: {} });
    const data = JSON.parse(textOf(result));
    expect(data.summary).toEqual({
      sites: 2,
      failed: 1,
      pendingPlugins: 1,
      pendingThemes: 0,
      pendingCore: 1,
      skipped: 0,
    });
  });

  it('fleet_find_plugin matches case-insensitively on file, slug and name', async () => {
    const siteA = makeSite({ id: 'a' });
    const siteB = makeSite({ id: 'b' });
    harness = await createHarness({
      sites: [siteA, siteB],
      fetch: createMockFetch((url) => {
        if (url.includes('a.example.com')) {
          return jsonResponse([{ plugin: 'akismet/akismet', name: 'Akismet', version: '5.3', status: 'active' }]);
        }
        return jsonResponse([{ plugin: 'hello-dolly/hello', name: 'Hello Dolly', version: '1.7', status: 'inactive' }]);
      }),
    });

    const result = await harness.client.callTool({ name: 'fleet_find_plugin', arguments: { query: 'AKISMET' } });
    const data = JSON.parse(textOf(result));
    expect(data.summary).toMatchObject({ sitesChecked: 2, sitesWithMatch: 1, failed: 0 });
    const bySite = Object.fromEntries(data.results.map((r: { site: string; matches: unknown[] }) => [r.site, r.matches]));
    expect(bySite.a).toHaveLength(1);
    expect(bySite.b).toHaveLength(0);
  });

  it('fleet_user_audit filters by role and an exact case-insensitive email', async () => {
    const siteA = makeSite({ id: 'a' });
    harness = await createHarness({
      sites: [siteA],
      fetch: createMockFetch((url) => {
        expect(url).toContain('roles=administrator');
        return jsonResponse(
          [
            { id: 1, username: 'alice', email: 'Alice@Example.com', roles: ['administrator'] },
            { id: 2, username: 'bob', email: 'bob@example.com', roles: ['administrator'] },
          ],
          { headers: { 'x-wp-totalpages': '1' } },
        );
      }),
    });

    const result = await harness.client.callTool({
      name: 'fleet_user_audit',
      arguments: { email: 'alice@example.com' },
    });
    const data = JSON.parse(textOf(result));
    expect(data.summary).toMatchObject({ totalUsers: 1, failed: 0 });
    expect(data.results[0].users).toEqual([{ id: 1, username: 'alice', email: 'Alice@Example.com', roles: ['administrator'] }]);
  });

  it('fleet_update_plugin dry-runs by default across the fleet', async () => {
    const siteA = makeSite({ id: 'a' });
    const siteB = makeSite({ id: 'b' });
    harness = await createHarness({
      sites: [siteA, siteB],
      fetch: createMockFetch((url) => {
        if (url.includes('a.example.com')) {
          return jsonResponse({ plugins: [{ plugin: 'akismet/akismet.php', current_version: '5.3', new_version: '5.4' }] });
        }
        return jsonResponse({ plugins: [] });
      }),
    });

    const result = await harness.client.callTool({ name: 'fleet_update_plugin', arguments: { plugin: 'akismet/akismet' } });
    const data = JSON.parse(textOf(result));
    expect(data.dryRun).toBe(true);
    expect(data.summary).toMatchObject({ wouldUpdate: 1, noUpdateAvailable: 1, failed: 0 });
  });

  it('fleet_update_plugin confirmed: updates a writable site, skips a readOnly site, and reports both', async () => {
    const writable = makeSite({ id: 'writable' });
    const readOnly = makeSite({ id: 'readonly', readOnly: true });
    let posted = false;
    harness = await createHarness({
      sites: [writable, readOnly],
      fetch: createMockFetch((url, init) => {
        if (init?.method === 'POST') {
          posted = true;
          return jsonResponse({ results: [{ plugin: 'akismet/akismet.php', success: true }] });
        }
        return jsonResponse({ plugins: [{ plugin: 'akismet/akismet.php', current_version: '5.3', new_version: '5.4' }] });
      }),
    });

    const result = await harness.client.callTool({
      name: 'fleet_update_plugin',
      arguments: { plugin: 'akismet/akismet', confirm: true },
    });
    const data = JSON.parse(textOf(result));
    expect(data.summary).toMatchObject({ updated: 1, skippedReadOnly: 1, failed: 0 });
    expect(posted).toBe(true);
    expect(harness.auditEntries).toHaveLength(1);
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'fleet_update_plugin', site: 'writable', ok: true });
  });

  it('fleet_update_plugin reports a partial failure when one site errors and others succeed', async () => {
    const good = makeSite({ id: 'good' });
    const bad = makeSite({ id: 'bad' });
    harness = await createHarness({
      sites: [good, bad],
      fetch: createMockFetch((url) => {
        if (url.includes('bad.')) {
          return jsonResponse({ code: 'rest_forbidden', message: 'nope' }, { status: 403 });
        }
        return jsonResponse({ plugins: [{ plugin: 'akismet/akismet.php', current_version: '5.3', new_version: '5.4' }] });
      }),
    });

    const result = await harness.client.callTool({ name: 'fleet_update_plugin', arguments: { plugin: 'akismet/akismet' } });
    const data = JSON.parse(textOf(result));
    expect(data.summary.failed).toBe(1);
    expect(data.summary.wouldUpdate).toBe(1);
    const bySite = Object.fromEntries(data.results.map((r: { site: string; ok: boolean }) => [r.site, r.ok]));
    expect(bySite.good).toBe(true);
    expect(bySite.bad).toBe(false);
  });

  it('fleet_update_plugin confirmed: audits and reports a failure when the POST itself fails', async () => {
    const site = makeSite({ id: 'flaky' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') {
          return jsonResponse({ code: 'internal_error', message: 'boom' }, { status: 500 });
        }
        return jsonResponse({ plugins: [{ plugin: 'akismet/akismet.php', current_version: '5.3', new_version: '5.4' }] });
      }),
    });

    const result = await harness.client.callTool({
      name: 'fleet_update_plugin',
      arguments: { plugin: 'akismet/akismet', confirm: true },
    });
    const data = JSON.parse(textOf(result));
    expect(data.summary).toMatchObject({ failed: 1, updated: 0 });
    expect(harness.auditEntries).toHaveLength(1);
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'fleet_update_plugin', site: 'flaky', ok: false });
  });

  it('fleet_update_plugin confirmed: reports a per-site failure and audits ok:false when the bridge responds 200 with success:false', async () => {
    const site = makeSite({ id: 'flaky2' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') {
          return jsonResponse({ results: [{ plugin: 'akismet/akismet.php', success: false, error: 'checksum mismatch' }] });
        }
        return jsonResponse({ plugins: [{ plugin: 'akismet/akismet.php', current_version: '5.3', new_version: '5.4' }] });
      }),
    });

    const result = await harness.client.callTool({
      name: 'fleet_update_plugin',
      arguments: { plugin: 'akismet/akismet', confirm: true },
    });
    const data = JSON.parse(textOf(result));

    expect(data.summary).toMatchObject({ updated: 0, failed: 1 });
    const entry = data.results.find((r: { site: string }) => r.site === 'flaky2');
    expect(entry).toMatchObject({ ok: false, error: 'checksum mismatch', data: { status: 'failed', error: 'checksum mismatch' } });
    expect(harness.auditEntries).toHaveLength(1);
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'fleet_update_plugin', site: 'flaky2', ok: false, error: 'checksum mismatch' });
  });

  it('fleet_update_plugin treats a missing/empty bridge results array as a failure, not an update', async () => {
    const site = makeSite({ id: 'noresult' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') return jsonResponse({});
        return jsonResponse({ plugins: [{ plugin: 'akismet/akismet.php', current_version: '5.3', new_version: '5.4' }] });
      }),
    });

    const result = await harness.client.callTool({
      name: 'fleet_update_plugin',
      arguments: { plugin: 'akismet/akismet', confirm: true },
    });
    const data = JSON.parse(textOf(result));
    expect(data.summary).toMatchObject({ updated: 0, failed: 1 });
    const entry = data.results.find((r: { site: string }) => r.site === 'noresult');
    expect(entry).toMatchObject({ ok: false, error: 'bridge returned no result', data: { status: 'failed', error: 'bridge returned no result' } });
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'fleet_update_plugin', site: 'noresult', ok: false, error: 'bridge returned no result' });
  });

  it('fleet_updates_report, fleet_find_plugin and fleet_user_audit surface an error for an unknown explicit site id', async () => {
    harness = await createHarness({ sites: [makeSite({ id: 'a' })] });

    const report = await harness.client.callTool({
      name: 'fleet_updates_report',
      arguments: { sites: ['nope'] },
    });
    expect(report.isError).toBe(true);

    const find = await harness.client.callTool({
      name: 'fleet_find_plugin',
      arguments: { query: 'akismet', sites: ['nope'] },
    });
    expect(find.isError).toBe(true);

    const audit = await harness.client.callTool({
      name: 'fleet_user_audit',
      arguments: { sites: ['nope'] },
    });
    expect(audit.isError).toBe(true);
  });

  it('fleet_update_plugin rejects an invalid plugin identifier', async () => {
    harness = await createHarness({ sites: [makeSite({ id: 'a' })] });
    const result = await harness.client.callTool({ name: 'fleet_update_plugin', arguments: { plugin: '../evil' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('invalid plugin identifier');
  });

  it('MCP_READ_ONLY hides fleet_update_plugin but keeps the read-only fleet tools', async () => {
    harness = await createHarness({ sites: [makeSite({ id: 'a' })], readOnlyGlobal: true });
    const { tools } = await harness.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('fleet_health');
    expect(names).toContain('fleet_updates_report');
    expect(names).toContain('fleet_find_plugin');
    expect(names).toContain('fleet_user_audit');
    expect(names).not.toContain('fleet_update_plugin');
  });
});
