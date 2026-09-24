import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, createMockFetch, jsonResponse, makeSite, type Harness } from '../helpers/harness.js';

function textOf(result: Awaited<ReturnType<Harness['client']['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe('tools/settings', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('get_settings returns the raw settings object', async () => {
    harness = await createHarness({
      sites: [makeSite({ id: 'acme' })],
      fetch: createMockFetch(() => jsonResponse({ title: 'ACME', posts_per_page: 10 })),
    });
    const result = await harness.client.callTool({ name: 'get_settings', arguments: { site: 'acme' } });
    expect(JSON.parse(textOf(result))).toEqual({ title: 'ACME', posts_per_page: 10 });
  });

  describe('update_settings', () => {
    it('dry-run fetches current settings and shows current -> new values, without writing', async () => {
      let wrote = false;
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((_url, init) => {
          if (init?.method === 'POST') wrote = true;
          return jsonResponse({ title: 'Old Title', posts_per_page: 10 });
        }),
      });

      const result = await harness.client.callTool({
        name: 'update_settings',
        arguments: { site: 'acme', values: { title: 'New Title', posts_per_page: 20 } },
      });
      const data = JSON.parse(textOf(result));

      expect(wrote).toBe(false);
      expect(data).toMatchObject({
        dryRun: true,
        wouldDo: {
          action: 'update_settings',
          changes: {
            title: { from: 'Old Title', to: 'New Title' },
            posts_per_page: { from: 10, to: 20 },
          },
        },
      });
      expect(harness.auditEntries).toHaveLength(0);
    });

    it('confirmed POSTs only the given values', async () => {
      let capturedBody: unknown;
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((_url, init) => {
          if (init?.method === 'POST') {
            capturedBody = JSON.parse(String(init.body));
            return jsonResponse({ title: 'New Title' });
          }
          return jsonResponse({ title: 'Old Title' });
        }),
      });

      const result = await harness.client.callTool({
        name: 'update_settings',
        arguments: { site: 'acme', values: { title: 'New Title' }, confirm: true },
      });

      expect(capturedBody).toEqual({ title: 'New Title' });
      expect(JSON.parse(textOf(result))).toEqual({ title: 'New Title' });
      expect(harness.auditEntries).toHaveLength(1);
      expect(harness.auditEntries[0]).toMatchObject({ ok: true, tool: 'update_settings' });
    });

    it('rejects an unknown settings key', async () => {
      harness = await createHarness({ sites: [makeSite({ id: 'acme' })] });
      const result = await harness.client.callTool({
        name: 'update_settings',
        arguments: { site: 'acme', values: { not_a_real_setting: 'x' } },
      });
      expect(result.isError).toBe(true);
    });

    it('refuses a confirmed write against a readOnly site, without calling POST', async () => {
      let wrote = false;
      harness = await createHarness({
        sites: [makeSite({ id: 'acme', readOnly: true })],
        fetch: createMockFetch((_url, init) => {
          if (init?.method === 'POST') wrote = true;
          return jsonResponse({ title: 'Old Title' });
        }),
      });
      const result = await harness.client.callTool({
        name: 'update_settings',
        arguments: { site: 'acme', values: { title: 'New Title' }, confirm: true },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/read-only/);
      expect(wrote).toBe(false);
      expect(harness.auditEntries).toHaveLength(1);
      expect(harness.auditEntries[0]).toMatchObject({ ok: false });
    });

    it('is not registered when MCP_READ_ONLY is true', async () => {
      harness = await createHarness({ sites: [makeSite({ id: 'acme' })], readOnlyGlobal: true });
      const { tools } = await harness.client.listTools();
      expect(tools.find((t) => t.name === 'update_settings')).toBeUndefined();
      expect(tools.find((t) => t.name === 'get_settings')).toBeDefined();
    });
  });
});
