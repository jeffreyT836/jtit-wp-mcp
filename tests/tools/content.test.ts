import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, createMockFetch, jsonResponse, makeSite, type Harness } from '../helpers/harness.js';

function textOf(result: Awaited<ReturnType<Harness['client']['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe('tools/content', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  describe('list_posts', () => {
    it('defaults to posts, status=any with context=edit, and maps fields', async () => {
      let capturedUrl = '';
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url) => {
          capturedUrl = url;
          return jsonResponse([
            {
              id: 1,
              title: { rendered: 'Hello <b>World</b>' },
              status: 'draft',
              date: '2024-01-01T00:00:00',
              modified: '2024-01-02T00:00:00',
              link: 'https://acme.example.com/?p=1',
              author: 3,
            },
          ]);
        }),
      });

      const result = await harness.client.callTool({ name: 'list_posts', arguments: { site: 'acme' } });
      const data = JSON.parse(textOf(result));

      expect(capturedUrl).toContain('/wp/v2/posts');
      expect(capturedUrl).toContain('status=any');
      expect(capturedUrl).toContain('context=edit');
      expect(data).toEqual([
        { id: 1, title: 'Hello <b>World</b>', status: 'draft', date: '2024-01-01T00:00:00', modified: '2024-01-02T00:00:00', link: 'https://acme.example.com/?p=1', author: 3 },
      ]);
    });

    it('lists pages, and omits context=edit for status=publish', async () => {
      let capturedUrl = '';
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url) => {
          capturedUrl = url;
          return jsonResponse([]);
        }),
      });

      await harness.client.callTool({
        name: 'list_posts',
        arguments: { site: 'acme', type: 'page', status: 'publish', search: 'about', per_page: 5 },
      });

      expect(capturedUrl).toContain('/wp/v2/pages');
      expect(capturedUrl).toContain('status=publish');
      expect(capturedUrl).toContain('search=about');
      expect(capturedUrl).toContain('per_page=5');
      expect(capturedUrl).not.toContain('context=edit');
    });

    it('sends context=edit when status is explicitly "any" (WP requires it for non-public statuses)', async () => {
      let capturedUrl = '';
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url) => {
          capturedUrl = url;
          return jsonResponse([]);
        }),
      });
      await harness.client.callTool({
        name: 'list_posts',
        arguments: { site: 'acme', status: 'any' },
      });
      expect(capturedUrl).toContain('status=any');
      expect(capturedUrl).toContain('context=edit');
    });

    it('rejects an out-of-range per_page', async () => {
      harness = await createHarness({ sites: [makeSite({ id: 'acme' })] });
      const result = await harness.client.callTool({
        name: 'list_posts',
        arguments: { site: 'acme', per_page: 500 },
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_comments', () => {
    it('defaults to status=hold and strips/truncates HTML content to 300 chars', async () => {
      let capturedUrl = '';
      const longText = 'a'.repeat(400);
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url) => {
          capturedUrl = url;
          return jsonResponse([
            {
              id: 5,
              post: 1,
              author_name: 'Visitor',
              date: '2024-02-01T00:00:00',
              status: 'hold',
              content: { rendered: `<p>${longText}</p>` },
            },
          ]);
        }),
      });

      const result = await harness.client.callTool({ name: 'list_comments', arguments: { site: 'acme' } });
      const data = JSON.parse(textOf(result));

      expect(capturedUrl).toContain('status=hold');
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({ id: 5, post: 1, author_name: 'Visitor', status: 'hold' });
      expect(data[0].content).not.toContain('<p>');
      expect(data[0].content.length).toBeLessThanOrEqual(300);
    });

    it('forwards an explicit status and per_page', async () => {
      let capturedUrl = '';
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url) => {
          capturedUrl = url;
          return jsonResponse([]);
        }),
      });
      await harness.client.callTool({
        name: 'list_comments',
        arguments: { site: 'acme', status: 'spam', per_page: 10 },
      });
      expect(capturedUrl).toContain('status=spam');
      expect(capturedUrl).toContain('per_page=10');
    });

    it('maps status "approved" to the WP query value "approve"', async () => {
      let capturedUrl = '';
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url) => {
          capturedUrl = url;
          return jsonResponse([]);
        }),
      });
      await harness.client.callTool({
        name: 'list_comments',
        arguments: { site: 'acme', status: 'approved' },
      });
      expect(capturedUrl).toContain('status=approve');
      expect(capturedUrl).not.toContain('status=approved');
    });

    it('maps status "any" to the WP query value "all"', async () => {
      let capturedUrl = '';
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url) => {
          capturedUrl = url;
          return jsonResponse([]);
        }),
      });
      await harness.client.callTool({
        name: 'list_comments',
        arguments: { site: 'acme', status: 'any' },
      });
      expect(capturedUrl).toContain('status=all');
    });
  });

  describe('moderate_comment', () => {
    it('dry-run previews the action and makes no request', async () => {
      let called = false;
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch(() => {
          called = true;
          return jsonResponse({});
        }),
      });
      const result = await harness.client.callTool({
        name: 'moderate_comment',
        arguments: { site: 'acme', id: 5, status: 'approved' },
      });
      expect(called).toBe(false);
      expect(JSON.parse(textOf(result))).toMatchObject({
        dryRun: true,
        wouldDo: { comment_id: 5, to_status: 'approved' },
      });
    });

    it('confirmed with status=trash issues a DELETE', async () => {
      let capturedMethod: string | undefined;
      let capturedUrl = '';
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url, init) => {
          capturedUrl = url;
          capturedMethod = init?.method;
          return jsonResponse({ deleted: true });
        }),
      });
      const result = await harness.client.callTool({
        name: 'moderate_comment',
        arguments: { site: 'acme', id: 5, status: 'trash', confirm: true },
      });
      expect(capturedMethod).toBe('DELETE');
      expect(capturedUrl).toContain('/wp/v2/comments/5');
      expect(capturedUrl).not.toContain('force');
      expect(JSON.parse(textOf(result))).toMatchObject({ deleted: true });
    });

    it('confirmed with status=approved issues a POST {status}', async () => {
      let capturedBody: unknown;
      let capturedMethod: string | undefined;
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((_url, init) => {
          capturedMethod = init?.method;
          capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
          return jsonResponse({ id: 5, status: 'approved' });
        }),
      });
      const result = await harness.client.callTool({
        name: 'moderate_comment',
        arguments: { site: 'acme', id: 5, status: 'approved', confirm: true },
      });
      expect(capturedMethod).toBe('POST');
      expect(capturedBody).toEqual({ status: 'approved' });
      expect(harness.auditEntries).toHaveLength(1);
      expect(JSON.parse(textOf(result))).toMatchObject({ status: 'approved' });
    });

    it('refuses a confirmed write against a readOnly site', async () => {
      harness = await createHarness({ sites: [makeSite({ id: 'acme', readOnly: true })] });
      const result = await harness.client.callTool({
        name: 'moderate_comment',
        arguments: { site: 'acme', id: 5, status: 'spam', confirm: true },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/read-only/);
    });

    it('is not registered when MCP_READ_ONLY is true', async () => {
      harness = await createHarness({ sites: [makeSite({ id: 'acme' })], readOnlyGlobal: true });
      const { tools } = await harness.client.listTools();
      expect(tools.find((t) => t.name === 'moderate_comment')).toBeUndefined();
      expect(tools.find((t) => t.name === 'list_posts')).toBeDefined();
    });
  });
});
