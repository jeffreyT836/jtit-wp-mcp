import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, createMockFetch, jsonResponse, makeSite, type Harness } from '../helpers/harness.js';

function textOf(result: Awaited<ReturnType<Harness['client']['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

const sampleUpdates = {
  checked_at: '2026-01-01T00:00:00Z',
  core: [{ current: '6.4', version: '6.5', response: 'upgrade', locale: 'en_US' }],
  plugins: [
    { plugin: 'akismet/akismet.php', name: 'Akismet', current_version: '5.3', new_version: '5.4' },
    { plugin: 'jetpack/jetpack.php', name: 'Jetpack', current_version: '12.0', new_version: '12.1' },
  ],
  themes: [{ stylesheet: 'twentytwentyfour', current_version: '1.0', new_version: '1.1' }],
  translations: { count: 3 },
};

describe('tools/updates', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('list_updates returns the bridge payload', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        expect(url).toContain('/nb-mcp/v1/updates');
        return jsonResponse(sampleUpdates);
      }),
    });
    const result = await harness.client.callTool({ name: 'list_updates', arguments: { site: 'acme' } });
    expect(JSON.parse(textOf(result))).toEqual(sampleUpdates);
  });

  it('list_updates passes refresh=1 when requested', async () => {
    const site = makeSite({ id: 'acme' });
    let sawUrl = '';
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        sawUrl = url;
        return jsonResponse(sampleUpdates);
      }),
    });
    await harness.client.callTool({ name: 'list_updates', arguments: { site: 'acme', refresh: true } });
    expect(sawUrl).toContain('refresh=1');
  });

  it('list_updates reports a clear error when the bridge mu-plugin is missing', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch(() => jsonResponse({ code: 'rest_no_route', message: 'No route' }, { status: 404 })),
    });
    const result = await harness.client.callTool({ name: 'list_updates', arguments: { site: 'acme' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('nb-mcp-bridge mu-plugin not installed');
  });

  it('update_plugins with all:true previews from/to and makes no POST until confirmed', async () => {
    const site = makeSite({ id: 'acme' });
    const calls: Array<{ url: string; method?: string }> = [];
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url, init) => {
        calls.push({ url, method: init?.method });
        return jsonResponse(sampleUpdates);
      }),
    });

    const dryRun = await harness.client.callTool({
      name: 'update_plugins',
      arguments: { site: 'acme', all: true },
    });
    expect(JSON.parse(textOf(dryRun))).toEqual({
      dryRun: true,
      wouldDo: {
        action: 'update_plugins',
        site: 'acme',
        updates: [
          { plugin: 'akismet/akismet', from: '5.3', to: '5.4' },
          { plugin: 'jetpack/jetpack', from: '12.0', to: '12.1' },
        ],
      },
    });
    expect(calls.every((c) => c.method === undefined || c.method === 'GET')).toBe(true);
  });

  it('update_plugins confirmed with all:true posts every plugin file with the update timeout', async () => {
    const site = makeSite({ id: 'acme' });
    let sawBody: unknown;
    let sawTimeoutRespected = false;
    harness = await createHarness({
      sites: [site],
      env: { WP_UPDATE_TIMEOUT_MS: 12345 },
      fetch: createMockFetch((url, init) => {
        if (init?.method === 'POST') {
          sawBody = init.body ? JSON.parse(init.body as string) : undefined;
          sawTimeoutRespected = true;
          return jsonResponse({ results: [{ plugin: 'akismet/akismet.php', success: true, from: '5.3', to: '5.4' }] });
        }
        return jsonResponse(sampleUpdates);
      }),
    });

    const result = await harness.client.callTool({
      name: 'update_plugins',
      arguments: { site: 'acme', all: true, confirm: true },
    });
    expect(result.isError).toBeUndefined();
    expect(sawBody).toEqual({ plugins: ['akismet/akismet.php', 'jetpack/jetpack.php'] });
    expect(sawTimeoutRespected).toBe(true);
    expect(harness.auditEntries).toHaveLength(1);
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'update_plugins', ok: true });
  });

  it('update_plugins with an explicit list marks an entry with no pending update as no_update_available, not would-update', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch(() => jsonResponse(sampleUpdates)),
    });
    const result = await harness.client.callTool({
      name: 'update_plugins',
      arguments: { site: 'acme', plugins: ['akismet/akismet', 'hello-dolly/hello'] },
    });
    expect(JSON.parse(textOf(result))).toMatchObject({
      wouldDo: {
        updates: [{ plugin: 'akismet/akismet', from: '5.3', to: '5.4' }],
        no_update_available: [{ plugin: 'hello-dolly/hello', status: 'no_update_available' }],
      },
    });
  });

  it('update_plugins with only no-update entries posts nothing when confirmed', async () => {
    const site = makeSite({ id: 'acme' });
    let posted = false;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') posted = true;
        return jsonResponse(sampleUpdates);
      }),
    });
    const result = await harness.client.callTool({
      name: 'update_plugins',
      arguments: { site: 'acme', plugins: ['hello-dolly/hello'], confirm: true },
    });
    expect(result.isError).toBeUndefined();
    expect(posted).toBe(false);
    expect(JSON.parse(textOf(result))).toMatchObject({ updated: false });
  });

  it('update_plugins audits ok:false (but not isError) on a partial per-item failure, and isError on a total failure', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') {
          return jsonResponse({
            results: [
              { plugin: 'akismet/akismet.php', success: true },
              { plugin: 'jetpack/jetpack.php', success: false, error: 'checksum mismatch' },
            ],
          });
        }
        return jsonResponse(sampleUpdates);
      }),
    });

    const result = await harness.client.callTool({
      name: 'update_plugins',
      arguments: { site: 'acme', all: true, confirm: true },
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toMatchObject({
      results: [
        { plugin: 'akismet/akismet.php', success: true },
        { plugin: 'jetpack/jetpack.php', success: false, error: 'checksum mismatch' },
      ],
    });
    expect(harness.auditEntries).toHaveLength(1);
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'update_plugins', ok: false });
    expect((harness.auditEntries[0]!.error as string)).toContain('1/2');
  });

  it('update_plugins sets isError when every item fails', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') {
          return jsonResponse({ results: [{ plugin: 'akismet/akismet.php', success: false, error: 'boom' }] });
        }
        return jsonResponse(sampleUpdates);
      }),
    });

    const result = await harness.client.callTool({
      name: 'update_plugins',
      arguments: { site: 'acme', plugins: ['akismet/akismet'], confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'update_plugins', ok: false, error: expect.stringContaining('boom') });
  });

  it('update_plugins requires plugins or all', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({ sites: [site] });
    const result = await harness.client.callTool({ name: 'update_plugins', arguments: { site: 'acme' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('requires either');
  });

  it('update_plugins rejects an invalid plugin identifier', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({ sites: [site], fetch: createMockFetch(() => jsonResponse(sampleUpdates)) });
    const result = await harness.client.callTool({
      name: 'update_plugins',
      arguments: { site: 'acme', plugins: ['../evil'] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('invalid plugin identifier');
  });

  it('update_plugins with nothing to update makes no POST and says so, even when confirmed', async () => {
    const site = makeSite({ id: 'acme' });
    let posted = false;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') posted = true;
        return jsonResponse({ plugins: [] });
      }),
    });
    const result = await harness.client.callTool({
      name: 'update_plugins',
      arguments: { site: 'acme', all: true, confirm: true },
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toMatchObject({ updated: false });
    expect(posted).toBe(false);
  });

  it('update_plugins refuses a confirmed update on a readOnly site', async () => {
    const site = makeSite({ id: 'acme', readOnly: true });
    let posted = false;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') posted = true;
        return jsonResponse(sampleUpdates);
      }),
    });
    const result = await harness.client.callTool({
      name: 'update_plugins',
      arguments: { site: 'acme', all: true, confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/read-only/);
    expect(posted).toBe(false);
    expect(harness.auditEntries).toHaveLength(1);
    expect(harness.auditEntries[0]).toMatchObject({ ok: false });
  });

  it('update_themes previews and posts stylesheet slugs', async () => {
    const site = makeSite({ id: 'acme' });
    let sawBody: unknown;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') {
          sawBody = init.body ? JSON.parse(init.body as string) : undefined;
          return jsonResponse({ results: [{ theme: 'twentytwentyfour', success: true }] });
        }
        return jsonResponse(sampleUpdates);
      }),
    });

    const dryRun = await harness.client.callTool({ name: 'update_themes', arguments: { site: 'acme', all: true } });
    expect(JSON.parse(textOf(dryRun))).toMatchObject({
      wouldDo: { updates: [{ theme: 'twentytwentyfour', from: '1.0', to: '1.1' }] },
    });

    await harness.client.callTool({ name: 'update_themes', arguments: { site: 'acme', all: true, confirm: true } });
    expect(sawBody).toEqual({ themes: ['twentytwentyfour'] });
  });

  it('update_themes requires themes or all, and validates theme ids', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({ sites: [site], fetch: createMockFetch(() => jsonResponse(sampleUpdates)) });

    const missing = await harness.client.callTool({ name: 'update_themes', arguments: { site: 'acme' } });
    expect(missing.isError).toBe(true);

    const invalid = await harness.client.callTool({
      name: 'update_themes',
      arguments: { site: 'acme', themes: ['../evil'] },
    });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain('invalid theme identifier');

    const invalidChars = await harness.client.callTool({
      name: 'update_themes',
      arguments: { site: 'acme', themes: ['bad theme!'] },
    });
    expect(invalidChars.isError).toBe(true);
    expect(textOf(invalidChars)).toContain('invalid theme identifier');
  });

  it('update_themes previews an explicit, valid theme id', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({ sites: [site], fetch: createMockFetch(() => jsonResponse(sampleUpdates)) });
    const result = await harness.client.callTool({
      name: 'update_themes',
      arguments: { site: 'acme', themes: ['twentytwentyfour'] },
    });
    expect(JSON.parse(textOf(result))).toMatchObject({
      wouldDo: { updates: [{ theme: 'twentytwentyfour', from: '1.0', to: '1.1' }] },
    });
  });

  it('update_themes with nothing to update makes no POST', async () => {
    const site = makeSite({ id: 'acme' });
    let posted = false;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') posted = true;
        return jsonResponse({ themes: [] });
      }),
    });
    const result = await harness.client.callTool({
      name: 'update_themes',
      arguments: { site: 'acme', all: true, confirm: true },
    });
    expect(JSON.parse(textOf(result))).toMatchObject({ updated: false });
    expect(posted).toBe(false);
  });

  it('update_themes with an explicit list marks an entry with no pending update as no_update_available, not would-update', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({ sites: [site], fetch: createMockFetch(() => jsonResponse(sampleUpdates)) });
    const result = await harness.client.callTool({
      name: 'update_themes',
      arguments: { site: 'acme', themes: ['twentytwentyfour', 'twentytwentythree'] },
    });
    expect(JSON.parse(textOf(result))).toMatchObject({
      wouldDo: {
        updates: [{ theme: 'twentytwentyfour', from: '1.0', to: '1.1' }],
        no_update_available: [{ theme: 'twentytwentythree', status: 'no_update_available' }],
      },
    });
  });

  it('update_themes audits ok:false without isError on a partial per-item failure', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') {
          return jsonResponse({ results: [{ theme: 'twentytwentyfour', success: false, error: 'checksum mismatch' }] });
        }
        return jsonResponse(sampleUpdates);
      }),
    });
    const result = await harness.client.callTool({
      name: 'update_themes',
      arguments: { site: 'acme', all: true, confirm: true },
    });
    expect(result.isError).toBe(true); // only item, so also the total-failure case
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'update_themes', ok: false, error: expect.stringContaining('checksum mismatch') });
  });

  it('update_core previews the available update and posts allow_major when confirmed', async () => {
    const site = makeSite({ id: 'acme' });
    let sawBody: unknown;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') {
          sawBody = init.body ? JSON.parse(init.body as string) : undefined;
          return jsonResponse({ success: true, from: '6.4', to: '6.5' });
        }
        return jsonResponse(sampleUpdates);
      }),
    });

    const dryRun = await harness.client.callTool({ name: 'update_core', arguments: { site: 'acme' } });
    expect(JSON.parse(textOf(dryRun))).toEqual({
      dryRun: true,
      wouldDo: { action: 'update_core', site: 'acme', from: '6.4', to: '6.5', allow_major: false },
    });

    const confirmed = await harness.client.callTool({
      name: 'update_core',
      arguments: { site: 'acme', allow_major: true, confirm: true },
    });
    expect(confirmed.isError).toBeUndefined();
    expect(sawBody).toEqual({ allow_major: true });
  });

  it('update_core preview uses a fresh (refresh=1) check, not the cache', async () => {
    const site = makeSite({ id: 'acme' });
    let sawUrl = '';
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        sawUrl = url;
        return jsonResponse(sampleUpdates);
      }),
    });
    await harness.client.callTool({ name: 'update_core', arguments: { site: 'acme' } });
    expect(sawUrl).toContain('refresh=1');
  });

  it('update_core still POSTs and returns the bridge answer when confirmed, even though the last check showed no upgrade', async () => {
    const site = makeSite({ id: 'acme' });
    let posted = false;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') {
          posted = true;
          return jsonResponse({ success: true, from: '6.5', to: '6.5' });
        }
        return jsonResponse({ core: [{ current: '6.5', version: '6.5', response: 'latest' }] });
      }),
    });

    const dryRun = await harness.client.callTool({ name: 'update_core', arguments: { site: 'acme' } });
    expect(JSON.parse(textOf(dryRun))).toEqual({
      dryRun: true,
      wouldDo: { action: 'update_core', site: 'acme', message: 'core is already up to date' },
    });

    const result = await harness.client.callTool({ name: 'update_core', arguments: { site: 'acme', confirm: true } });
    expect(result.isError).toBeUndefined();
    expect(posted).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({ success: true, from: '6.5', to: '6.5' });
  });

  it('update_core audits ok:false and sets isError when the bridge reports success:false', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') return jsonResponse({ success: false, error: 'checksum mismatch' });
        return jsonResponse(sampleUpdates);
      }),
    });
    const result = await harness.client.callTool({ name: 'update_core', arguments: { site: 'acme', confirm: true } });
    expect(result.isError).toBe(true);
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'update_core', ok: false, error: 'checksum mismatch' });
  });

  it('update_translations dry-runs then posts when confirmed', async () => {
    const site = makeSite({ id: 'acme' });
    let posted = false;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url, init) => {
        expect(url).toContain('/nb-mcp/v1/updates/translations');
        posted = init?.method === 'POST';
        return jsonResponse({ success: true, count: 3 });
      }),
    });

    const dryRun = await harness.client.callTool({ name: 'update_translations', arguments: { site: 'acme' } });
    expect(JSON.parse(textOf(dryRun))).toEqual({ dryRun: true, wouldDo: { action: 'update_translations', site: 'acme' } });
    expect(posted).toBe(false);

    const confirmed = await harness.client.callTool({
      name: 'update_translations',
      arguments: { site: 'acme', confirm: true },
    });
    expect(confirmed.isError).toBeUndefined();
    expect(posted).toBe(true);
  });

  it('update_translations audits ok:false and sets isError when the bridge reports success:false', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        if (init?.method === 'POST') return jsonResponse({ success: false, error: 'network unreachable' });
        return jsonResponse(sampleUpdates);
      }),
    });
    const result = await harness.client.callTool({
      name: 'update_translations',
      arguments: { site: 'acme', confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'update_translations', ok: false, error: 'network unreachable' });
  });

  it('MCP_READ_ONLY hides every update write tool but keeps list_updates', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({ sites: [site], readOnlyGlobal: true });
    const { tools } = await harness.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_updates');
    expect(names).not.toContain('update_plugins');
    expect(names).not.toContain('update_themes');
    expect(names).not.toContain('update_core');
    expect(names).not.toContain('update_translations');
  });
});
