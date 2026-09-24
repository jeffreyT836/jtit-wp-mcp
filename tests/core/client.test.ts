import { describe, expect, it, vi } from 'vitest';
import { WpClient } from '../../src/wp/client.js';
import { WpError, sanitizeMessage } from '../../src/wp/errors.js';
import { createMockFetch, jsonResponse, makeSite } from '../helpers/harness.js';

describe('WpClient', () => {
  it('sends a Basic auth header built from username:password, against <url>/wp-json', async () => {
    const site = makeSite({ id: 'acme', url: 'https://acme.example.com', username: 'bot', password: 'secret pw' });
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const client = new WpClient(site, {
      fetch: createMockFetch((url, init) => {
        capturedUrl = url;
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return jsonResponse({ ok: true });
      }),
    });

    await client.request('/wp/v2/users/me');

    expect(capturedUrl).toBe('https://acme.example.com/wp-json/wp/v2/users/me');
    const expectedToken = Buffer.from('bot:secret pw').toString('base64');
    expect(capturedHeaders.authorization).toBe(`Basic ${expectedToken}`);
  });

  it('maps a non-2xx WP JSON error body to a WpError with its code/message', async () => {
    const site = makeSite({ id: 'acme' });
    const client = new WpClient(site, {
      fetch: createMockFetch(() =>
        jsonResponse({ code: 'rest_forbidden', message: 'Sorry, not allowed.' }, { status: 403 }),
      ),
    });

    await expect(client.request('/wp/v2/plugins')).rejects.toMatchObject({
      status: 403,
      code: 'rest_forbidden',
      message: 'Sorry, not allowed.',
    });
  });

  it('maps a non-2xx non-JSON response to a generic WpError', async () => {
    const site = makeSite({ id: 'acme' });
    const client = new WpClient(site, {
      fetch: createMockFetch(() => new Response('Internal Server Error', { status: 500 })),
    });

    await expect(client.request('/wp/v2/plugins')).rejects.toMatchObject({
      status: 500,
      code: 'nb_mcp_http_error',
    });
  });

  it('never includes an Authorization header or Basic token in an error message', async () => {
    const message = sanitizeMessage(
      'fetch failed for Authorization: Basic dXNlcjpzdXBlci1zZWNyZXQ= against https://user:pw@host/path',
    );
    expect(message).not.toContain('dXNlcjpzdXBlci1zZWNyZXQ=');
    expect(message).not.toContain('user:pw@');
  });

  it('never leaks the configured password when a site has no credentials at all', async () => {
    // `available: true` here is contrived (the real loader always marks a secret-less site
    // unavailable) — it isolates authHeader()'s own no-secret guard from the newer
    // assertSiteAccessible() unavailable-site guard, which is covered separately below.
    const site = makeSite({ id: 'acme', password: null, available: true, unavailableReason: null });
    const client = new WpClient(site, { fetch: createMockFetch(() => jsonResponse({})) });
    await expect(client.request('/wp/v2/users/me')).rejects.toMatchObject({ code: 'nb_mcp_no_secret' });
  });

  it('maps a fetch timeout (AbortError) to a WpError with code nb_mcp_timeout', async () => {
    const site = makeSite({ id: 'acme' });
    const client = new WpClient(site, {
      fetch: createMockFetch(() => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }),
    });

    await expect(client.request('/wp/v2/users/me', { timeoutMs: 5 })).rejects.toMatchObject({
      code: 'nb_mcp_timeout',
      status: 0,
    });
  });

  it('paginates getAll() using X-WP-TotalPages, at per_page=100', async () => {
    const site = makeSite({ id: 'acme' });
    const fetchMock = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      expect(new URL(url).searchParams.get('per_page')).toBe('100');
      if (page < 3) {
        return jsonResponse([{ id: page }], { headers: { 'X-WP-TotalPages': '3' } });
      }
      return jsonResponse([{ id: 3 }], { headers: { 'X-WP-TotalPages': '3' } });
    });
    const client = new WpClient(site, { fetch: createMockFetch(fetchMock) });

    const all = await client.getAll<{ id: number }>('/wp/v2/users');

    expect(all).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('caps getAll() at 20 pages even if the server reports more', async () => {
    const site = makeSite({ id: 'acme' });
    const fetchMock = vi.fn(async () => jsonResponse([{ id: 1 }], { headers: { 'X-WP-TotalPages': '999' } }));
    const client = new WpClient(site, { fetch: createMockFetch(fetchMock) });

    const all = await client.getAll('/wp/v2/users');

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(all).toHaveLength(20);
  });

  it('bridge() prefixes /nb-mcp/v1', async () => {
    const site = makeSite({ id: 'acme' });
    let capturedUrl = '';
    const client = new WpClient(site, {
      fetch: createMockFetch((url) => {
        capturedUrl = url;
        return jsonResponse({ bridge_version: '1.0.0' });
      }),
    });

    await client.bridge('/status');

    expect(capturedUrl).toBe('https://acme.example.com/wp-json/nb-mcp/v1/status');
  });

  it('bridge() refuses when site.bridge === false', async () => {
    const site = makeSite({ id: 'acme', bridge: false });
    const client = new WpClient(site, { fetch: createMockFetch(() => jsonResponse({})) });

    await expect(client.bridge('/status')).rejects.toMatchObject({ code: 'nb_mcp_bridge_disabled' });
  });

  it('bridge() converts a 404 rest_no_route into a friendly "mu-plugin not installed" error', async () => {
    const site = makeSite({ id: 'acme' });
    const client = new WpClient(site, {
      fetch: createMockFetch(() =>
        jsonResponse({ code: 'rest_no_route', message: 'No route was found.' }, { status: 404 }),
      ),
    });

    await expect(client.bridge('/status')).rejects.toBeInstanceOf(WpError);
    await expect(client.bridge('/status')).rejects.toMatchObject({
      code: 'nb_mcp_bridge_missing',
      message: expect.stringContaining('nb-mcp-bridge mu-plugin not installed on acme'),
    });
  });

  it('refuses to send any request to an unavailable site, without calling fetch', async () => {
    const site = makeSite({ id: 'acme', available: false, unavailableReason: 'missing secret', password: null });
    let called = false;
    const client = new WpClient(site, {
      fetch: createMockFetch(() => {
        called = true;
        return jsonResponse({});
      }),
    });

    await expect(client.request('/wp/v2/plugins')).rejects.toMatchObject({ code: 'nb_mcp_site_unavailable' });
    expect(called).toBe(false);
  });

  it('refuses a non-https base URL when allowHttp is not set, without calling fetch or sending Basic auth', async () => {
    const site = makeSite({
      id: 'acme',
      url: 'http://acme.example.com',
      allowHttp: false,
      available: true, // simulates a caller bypassing the loader's own scheme check
    });
    let called = false;
    const client = new WpClient(site, {
      fetch: createMockFetch(() => {
        called = true;
        return jsonResponse({});
      }),
    });

    await expect(client.request('/wp/v2/plugins')).rejects.toMatchObject({ code: 'nb_mcp_insecure_url' });
    expect(called).toBe(false);
  });

  it('allows a non-https base URL when allowHttp is true', async () => {
    const site = makeSite({ id: 'acme', url: 'http://acme.example.com', allowHttp: true, available: true });
    const client = new WpClient(site, { fetch: createMockFetch(() => jsonResponse({ ok: true })) });

    await expect(client.request('/wp/v2/plugins')).resolves.toEqual({ ok: true });
  });

  it('does not remap an unrelated 404 from a bridge call', async () => {
    const site = makeSite({ id: 'acme' });
    const client = new WpClient(site, {
      fetch: createMockFetch(() =>
        jsonResponse({ code: 'nb_mcp_not_found', message: 'thing not found' }, { status: 404 }),
      ),
    });

    await expect(client.bridge('/status')).rejects.toMatchObject({ code: 'nb_mcp_not_found' });
  });
});
