import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, createMockFetch, jsonResponse, makeSite, type Harness } from '../helpers/harness.js';

function textOf(result: Awaited<ReturnType<Harness['client']['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe('tools/sites', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('list_sites reports fields but never secrets', async () => {
    const site = makeSite({
      id: 'acme',
      name: 'ACME',
      url: 'https://acme.example.com',
      tags: ['production'],
      password: 'super-secret',
    });
    harness = await createHarness({ sites: [site] });

    const result = await harness.client.callTool({ name: 'list_sites', arguments: {} });
    const data = JSON.parse(textOf(result));

    expect(data).toEqual([
      {
        id: 'acme',
        name: 'ACME',
        url: 'https://acme.example.com',
        tags: ['production'],
        readOnly: false,
        bridge: true,
        available: true,
        unavailableReason: null,
      },
    ]);
    expect(textOf(result)).not.toContain('super-secret');
  });

  it('list_sites filters by tags', async () => {
    harness = await createHarness({
      sites: [makeSite({ id: 'a', tags: ['prod'] }), makeSite({ id: 'b', tags: ['staging'] })],
    });
    const result = await harness.client.callTool({ name: 'list_sites', arguments: { tags: ['prod'] } });
    const data = JSON.parse(textOf(result)) as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['a']);
  });

  it('site_check reports ok, roles, isAdmin and bridge status', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        if (url.includes('/wp/v2/users/me')) {
          return jsonResponse({ id: 1, username: 'mcp-bot', name: 'MCP Bot', roles: ['administrator'] });
        }
        if (url.includes('/nb-mcp/v1/status')) {
          return jsonResponse({ bridge_version: '1.0.0' });
        }
        throw new Error(`unexpected url: ${url}`);
      }),
    });

    const result = await harness.client.callTool({ name: 'site_check', arguments: { site: 'acme' } });
    const data = JSON.parse(textOf(result));

    expect(data).toMatchObject({
      site: 'acme',
      ok: true,
      roles: ['administrator'],
      isAdmin: true,
      bridge: 'ok',
      user: { id: 1, username: 'mcp-bot' },
    });
  });

  it('site_check reports bridge: "missing" when the mu-plugin is not installed', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        if (url.includes('/wp/v2/users/me')) {
          return jsonResponse({ id: 1, username: 'mcp-bot', roles: ['administrator'] });
        }
        return jsonResponse({ code: 'rest_no_route', message: 'No route' }, { status: 404 });
      }),
    });

    const result = await harness.client.callTool({ name: 'site_check', arguments: { site: 'acme' } });
    expect(JSON.parse(textOf(result))).toMatchObject({ bridge: 'missing' });
  });

  it('site_check reports bridge: "disabled" when site.bridge is false, without calling it', async () => {
    const site = makeSite({ id: 'acme', bridge: false });
    let bridgeCalled = false;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        if (url.includes('/nb-mcp/v1')) bridgeCalled = true;
        return jsonResponse({ id: 1, roles: ['administrator'] });
      }),
    });

    const result = await harness.client.callTool({ name: 'site_check', arguments: { site: 'acme' } });
    expect(JSON.parse(textOf(result))).toMatchObject({ bridge: 'disabled' });
    expect(bridgeCalled).toBe(false);
  });

  it('site_check short-circuits with a clear error for an unavailable site (missing secret)', async () => {
    const site = makeSite({ id: 'acme', available: false, unavailableReason: 'missing secret', password: null });
    let called = false;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch(() => {
        called = true;
        return jsonResponse({});
      }),
    });

    const result = await harness.client.callTool({ name: 'site_check', arguments: { site: 'acme' } });
    expect(JSON.parse(textOf(result))).toMatchObject({ ok: false, error: expect.stringContaining('missing secret') });
    expect(called).toBe(false);
  });

  it('site_check returns isError for an unknown site id', async () => {
    harness = await createHarness({ sites: [makeSite({ id: 'acme' })] });
    const result = await harness.client.callTool({ name: 'site_check', arguments: { site: 'nope' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('nope');
  });

  it('site_info returns the WP index fields plus bridge status', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        if (url.includes('/nb-mcp/v1/status')) return jsonResponse({ bridge_version: '1.0.0' });
        return jsonResponse({
          name: 'ACME Site',
          description: 'An example site',
          url: 'https://acme.example.com',
          timezone_string: 'Europe/Amsterdam',
          namespaces: ['wp/v2', 'nb-mcp/v1'],
        });
      }),
    });

    const result = await harness.client.callTool({ name: 'site_info', arguments: { site: 'acme' } });
    expect(JSON.parse(textOf(result))).toMatchObject({
      site: 'acme',
      name: 'ACME Site',
      timezone_string: 'Europe/Amsterdam',
      namespaces: ['wp/v2', 'nb-mcp/v1'],
      bridge: 'ok',
    });
  });
});
