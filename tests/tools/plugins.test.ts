import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, createMockFetch, jsonResponse, makeSite, type Harness } from '../helpers/harness.js';

function textOf(result: Awaited<ReturnType<Harness['client']['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe('tools/plugins', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('list_plugins maps fields from GET /wp/v2/plugins', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        expect(url).toContain('/wp/v2/plugins');
        return jsonResponse(
          [
            {
              plugin: 'akismet/akismet',
              name: 'Akismet',
              version: '5.3',
              status: 'active',
              author: 'Automattic',
              requires_wp: '6.0',
              requires_php: '7.2',
              network_only: false,
            },
          ],
          { headers: { 'x-wp-totalpages': '1' } },
        );
      }),
    });

    const result = await harness.client.callTool({ name: 'list_plugins', arguments: { site: 'acme' } });
    expect(JSON.parse(textOf(result))).toEqual([
      {
        plugin: 'akismet/akismet',
        name: 'Akismet',
        version: '5.3',
        status: 'active',
        author: 'Automattic',
        requires_wp: '6.0',
        requires_php: '7.2',
        network_only: false,
      },
    ]);
  });

  it('list_plugins refuses an unavailable site (e.g. http:// without allowHttp) without ever sending the Basic auth header', async () => {
    const site = makeSite({
      id: 'insecure',
      url: 'http://insecure.example.com',
      allowHttp: false,
      available: false,
      unavailableReason: 'site url is not https:// and allowHttp is not enabled',
    });
    let called = false;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch(() => {
        called = true;
        return jsonResponse([]);
      }),
    });

    const result = await harness.client.callTool({ name: 'list_plugins', arguments: { site: 'insecure' } });

    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/https/);
  });

  it('list_plugins surfaces an error for an unknown site', async () => {
    harness = await createHarness({ sites: [makeSite({ id: 'acme' })] });
    const result = await harness.client.callTool({ name: 'list_plugins', arguments: { site: 'nope' } });
    expect(result.isError).toBe(true);
  });

  it('activate_plugin without confirm returns a dry-run preview and makes no POST', async () => {
    const site = makeSite({ id: 'acme' });
    let called = false;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch(() => {
        called = true;
        return jsonResponse({});
      }),
    });

    const result = await harness.client.callTool({
      name: 'activate_plugin',
      arguments: { site: 'acme', plugin: 'akismet/akismet' },
    });
    expect(JSON.parse(textOf(result))).toEqual({
      dryRun: true,
      wouldDo: { action: 'activate_plugin', site: 'acme', plugin: 'akismet/akismet' },
    });
    expect(called).toBe(false);
  });

  it('activate_plugin accepts an id with a trailing .php and normalizes it', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({ sites: [site] });
    const result = await harness.client.callTool({
      name: 'activate_plugin',
      arguments: { site: 'acme', plugin: 'akismet/akismet.php' },
    });
    expect(JSON.parse(textOf(result))).toMatchObject({ wouldDo: { plugin: 'akismet/akismet' } });
  });

  it('rejects an invalid plugin identifier (path traversal) with a clear error', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({ sites: [site] });
    const result = await harness.client.callTool({
      name: 'activate_plugin',
      arguments: { site: 'acme', plugin: '../../etc/passwd' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('invalid plugin identifier');
  });

  it('accepts a single-file plugin identifier (no directory), matching WP core\'s own route pattern', async () => {
    const site = makeSite({ id: 'acme' });
    let sawUrl: string | undefined;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        sawUrl = url;
        return jsonResponse({ plugin: 'hello', status: 'active' });
      }),
    });

    const dryRun = await harness.client.callTool({
      name: 'activate_plugin',
      arguments: { site: 'acme', plugin: 'hello' },
    });
    expect(JSON.parse(textOf(dryRun))).toEqual({
      dryRun: true,
      wouldDo: { action: 'activate_plugin', site: 'acme', plugin: 'hello' },
    });

    const confirmed = await harness.client.callTool({
      name: 'activate_plugin',
      arguments: { site: 'acme', plugin: 'hello.php', confirm: true },
    });
    expect(confirmed.isError).toBeUndefined();
    expect(sawUrl).toContain('/wp/v2/plugins/hello');
    expect(sawUrl).not.toContain('/wp/v2/plugins/hello/');
  });

  it('rejects a plugin identifier with a dot inside a segment, and one with more than one slash', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({ sites: [site] });

    const dotted = await harness.client.callTool({
      name: 'activate_plugin',
      arguments: { site: 'acme', plugin: 'aki.smet/akismet' },
    });
    expect(dotted.isError).toBe(true);
    expect(textOf(dotted)).toContain('invalid plugin identifier');

    const tooManySegments = await harness.client.callTool({
      name: 'activate_plugin',
      arguments: { site: 'acme', plugin: 'a/b/c' },
    });
    expect(tooManySegments.isError).toBe(true);
    expect(textOf(tooManySegments)).toContain('invalid plugin identifier');
  });

  it('activate_plugin refuses a confirmed write on a readOnly site, without calling POST', async () => {
    const site = makeSite({ id: 'acme', readOnly: true });
    let called = false;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch(() => {
        called = true;
        return jsonResponse({});
      }),
    });

    const result = await harness.client.callTool({
      name: 'activate_plugin',
      arguments: { site: 'acme', plugin: 'akismet/akismet', confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/read-only/);
    expect(called).toBe(false);
    expect(harness.auditEntries).toHaveLength(1);
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'activate_plugin', ok: false });
  });

  it('activate_plugin performs the POST and audits success when confirmed on a writable site', async () => {
    const site = makeSite({ id: 'acme' });
    let sawMethod: string | undefined;
    let sawUrl: string | undefined;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url, init) => {
        sawUrl = url;
        sawMethod = init?.method;
        return jsonResponse({ plugin: 'akismet/akismet', status: 'active' });
      }),
    });

    const result = await harness.client.callTool({
      name: 'activate_plugin',
      arguments: { site: 'acme', plugin: 'akismet/akismet', confirm: true },
    });
    expect(result.isError).toBeUndefined();
    expect(sawMethod).toBe('POST');
    expect(sawUrl).toContain('/wp/v2/plugins/akismet/akismet');
    expect(JSON.parse(textOf(result))).toMatchObject({ status: 'active' });
    expect(harness.auditEntries).toHaveLength(1);
    expect(harness.auditEntries[0]).toMatchObject({ tool: 'activate_plugin', ok: true });
  });

  it('activate_plugin maps the raw WP response to the same shape as list_plugins, dropping extra fields', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch(() =>
        jsonResponse({
          plugin: 'akismet/akismet',
          status: 'active',
          name: 'Akismet',
          version: '5.4',
          _links: { self: [{ href: 'https://acme.example.com/wp-json/wp/v2/plugins/akismet/akismet' }] },
          textdomain: 'akismet',
        }),
      ),
    });
    const result = await harness.client.callTool({
      name: 'activate_plugin',
      arguments: { site: 'acme', plugin: 'akismet/akismet', confirm: true },
    });
    expect(JSON.parse(textOf(result))).toEqual({
      plugin: 'akismet/akismet',
      name: 'Akismet',
      version: '5.4',
      status: 'active',
      author: undefined,
      requires_wp: undefined,
      requires_php: undefined,
      network_only: undefined,
    });
  });

  it('deactivate_plugin previews (dry-run) then sends status: inactive when confirmed', async () => {
    const site = makeSite({ id: 'acme' });
    let sawBody: unknown;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        sawBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return jsonResponse({ status: 'inactive' });
      }),
    });

    const dryRun = await harness.client.callTool({
      name: 'deactivate_plugin',
      arguments: { site: 'acme', plugin: 'akismet/akismet' },
    });
    expect(JSON.parse(textOf(dryRun))).toEqual({
      dryRun: true,
      wouldDo: { action: 'deactivate_plugin', site: 'acme', plugin: 'akismet/akismet' },
    });

    await harness.client.callTool({
      name: 'deactivate_plugin',
      arguments: { site: 'acme', plugin: 'akismet/akismet', confirm: true },
    });
    expect(sawBody).toEqual({ status: 'inactive' });
  });

  it('install_plugin validates the slug and posts {slug, status}', async () => {
    const site = makeSite({ id: 'acme' });
    let sawBody: unknown;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((_url, init) => {
        sawBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return jsonResponse({ plugin: 'hello-dolly/hello' });
      }),
    });

    const dryRun = await harness.client.callTool({
      name: 'install_plugin',
      arguments: { site: 'acme', slug: 'hello-dolly' },
    });
    expect(JSON.parse(textOf(dryRun))).toEqual({
      dryRun: true,
      wouldDo: { action: 'install_plugin', site: 'acme', slug: 'hello-dolly', status: 'inactive' },
    });

    const confirmed = await harness.client.callTool({
      name: 'install_plugin',
      arguments: { site: 'acme', slug: 'hello-dolly', status: 'active', confirm: true },
    });
    expect(confirmed.isError).toBeUndefined();
    expect(sawBody).toEqual({ slug: 'hello-dolly', status: 'active' });
  });

  it('install_plugin rejects an invalid slug', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({ sites: [site] });
    const result = await harness.client.callTool({
      name: 'install_plugin',
      arguments: { site: 'acme', slug: 'not a slug!' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('invalid plugin slug');
  });

  it('delete_plugin previews (dry-run) then sends DELETE to the plugin route when confirmed', async () => {
    const site = makeSite({ id: 'acme' });
    let sawMethod: string | undefined;
    let sawUrl: string | undefined;
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url, init) => {
        sawUrl = url;
        sawMethod = init?.method;
        return jsonResponse({ deleted: true });
      }),
    });

    const dryRun = await harness.client.callTool({
      name: 'delete_plugin',
      arguments: { site: 'acme', plugin: 'akismet/akismet' },
    });
    expect(JSON.parse(textOf(dryRun))).toEqual({
      dryRun: true,
      wouldDo: { action: 'delete_plugin', site: 'acme', plugin: 'akismet/akismet' },
    });

    const result = await harness.client.callTool({
      name: 'delete_plugin',
      arguments: { site: 'acme', plugin: 'akismet/akismet', confirm: true },
    });
    expect(result.isError).toBeUndefined();
    expect(sawMethod).toBe('DELETE');
    expect(sawUrl).toContain('/wp/v2/plugins/akismet/akismet');
  });

  it('MCP_READ_ONLY hides every write tool but keeps list_plugins', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({ sites: [site], readOnlyGlobal: true });
    const { tools } = await harness.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_plugins');
    expect(names).not.toContain('activate_plugin');
    expect(names).not.toContain('deactivate_plugin');
    expect(names).not.toContain('install_plugin');
    expect(names).not.toContain('delete_plugin');
  });
});
