import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, createMockFetch, jsonResponse, makeSite, type Harness } from '../helpers/harness.js';

function textOf(result: Awaited<ReturnType<Harness['client']['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe('tools/themes', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('list_themes maps rendered name/author objects and plain strings', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        expect(url).toContain('/wp/v2/themes');
        expect(url).toContain('context=edit');
        return jsonResponse(
          [
            {
              stylesheet: 'twentytwentyfour',
              template: 'twentytwentyfour',
              status: 'active',
              name: { rendered: 'Twenty Twenty-Four', raw: 'Twenty Twenty-Four' },
              version: '1.2',
              author: { rendered: 'WordPress.org' },
              requires_wp: '6.4',
              requires_php: '7.0',
            },
            {
              stylesheet: 'child-theme',
              status: 'inactive',
              name: 'Child Theme',
              version: '0.1',
              author: 'Someone',
            },
          ],
          { headers: { 'x-wp-totalpages': '1' } },
        );
      }),
    });

    const result = await harness.client.callTool({ name: 'list_themes', arguments: { site: 'acme' } });
    expect(JSON.parse(textOf(result))).toEqual([
      {
        stylesheet: 'twentytwentyfour',
        template: 'twentytwentyfour',
        status: 'active',
        name: 'Twenty Twenty-Four',
        version: '1.2',
        author: 'WordPress.org',
        requires_wp: '6.4',
        requires_php: '7.0',
      },
      {
        stylesheet: 'child-theme',
        template: undefined,
        status: 'inactive',
        name: 'Child Theme',
        version: '0.1',
        author: 'Someone',
        requires_wp: undefined,
        requires_php: undefined,
      },
    ]);
  });

  it('list_themes forwards the status filter to the API', async () => {
    const site = makeSite({ id: 'acme' });
    let sawUrl = '';
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        sawUrl = url;
        return jsonResponse([], { headers: { 'x-wp-totalpages': '1' } });
      }),
    });

    await harness.client.callTool({ name: 'list_themes', arguments: { site: 'acme', status: 'active', search: 'twenty' } });
    expect(sawUrl).toContain('status=active');
  });

  it('list_themes filters by search client-side (name/stylesheet, case-insensitive), since the WP endpoint ignores it', async () => {
    const site = makeSite({ id: 'acme' });
    let sawUrl = '';
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch((url) => {
        sawUrl = url;
        // Simulates the real WP behavior: `search` is accepted in the query string but
        // ignored server-side — every theme is returned regardless.
        return jsonResponse(
          [
            { stylesheet: 'twentytwentyfour', name: { rendered: 'Twenty Twenty-Four' } },
            { stylesheet: 'child-theme', name: 'Child Theme' },
          ],
          { headers: { 'x-wp-totalpages': '1' } },
        );
      }),
    });

    const result = await harness.client.callTool({
      name: 'list_themes',
      arguments: { site: 'acme', search: 'TWENTY' },
    });
    const data = JSON.parse(textOf(result));

    expect(sawUrl).not.toContain('search=');
    expect(data.map((t: { stylesheet: string }) => t.stylesheet)).toEqual(['twentytwentyfour']);
  });

  it('surfaces a sanitized error for an unreachable site', async () => {
    const site = makeSite({ id: 'acme' });
    harness = await createHarness({
      sites: [site],
      fetch: createMockFetch(() => jsonResponse({ code: 'rest_forbidden', message: 'nope' }, { status: 403 })),
    });
    const result = await harness.client.callTool({ name: 'list_themes', arguments: { site: 'acme' } });
    expect(result.isError).toBe(true);
  });
});
