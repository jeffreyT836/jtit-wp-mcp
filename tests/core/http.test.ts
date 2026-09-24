import { createServer as createNetServer } from 'node:net';
import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLogger } from '../../src/audit.js';
import type { EnvConfig } from '../../src/config/schema.js';
import { expandAllowedHosts, startHttpServer, type HttpServerHandle } from '../../src/http.js';
import type { ToolContext } from '../../src/tools/context.js';
import { SiteRegistry } from '../../src/wp/registry.js';
import { createMockFetch, jsonResponse, makeSite } from '../helpers/harness.js';

const TOKEN = 'a'.repeat(40);

/** Picks a free TCP port on 127.0.0.1 by briefly binding to port 0. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function buildCtx(overrides: Partial<EnvConfig>, fetchImpl?: typeof fetch): ToolContext {
  const site = makeSite({ id: 'acme' });
  const registry = new SiteRegistry([site], { fetch: fetchImpl });
  const audit = new AuditLogger({ stderrWrite: () => {} });
  const env: EnvConfig = {
    SITES_CONFIG: undefined,
    MCP_TRANSPORT: 'http',
    MCP_HTTP_PORT: 0,
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_TOKEN: TOKEN,
    MCP_HTTP_ALLOWED_HOSTS: 'localhost,127.0.0.1',
    MCP_READ_ONLY: false,
    WP_TIMEOUT_MS: 30000,
    WP_UPDATE_TIMEOUT_MS: 300000,
    FLEET_CONCURRENCY: 4,
    AUDIT_LOG_FILE: undefined,
    ...overrides,
  };
  return { registry, env, audit, readOnlyGlobal: false };
}

/** Posts a JSON-RPC body to `/mcp` with a raw `http.request`, so the `Host` header can be
 * set to something other than what the socket actually connects to (native `fetch` silently
 * overrides any `Host` header with the real connection host, so it cannot be used for this). */
function postMcp(
  port: number,
  opts: { host: string; body: unknown },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host: opts.host,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const toolsCallBody = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('expandAllowedHosts', () => {
  it('adds "<entry>:<port>" for a bare entry, keeping the bare entry too', () => {
    expect(expandAllowedHosts('localhost,127.0.0.1', 3000)).toEqual(
      expect.arrayContaining(['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:3000']),
    );
  });

  it('leaves an entry that already carries a port untouched', () => {
    expect(expandAllowedHosts('example.com:8443', 3000)).toEqual(['example.com:8443']);
  });
});

describe('HTTP transport', () => {
  let handle: HttpServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('accepts a Host header of "<hostname>:<MCP_HTTP_PORT>" for a bare configured hostname', async () => {
    const port = await getFreePort();
    const ctx = buildCtx({ MCP_HTTP_PORT: port, MCP_HTTP_ALLOWED_HOSTS: 'localhost' });
    handle = await startHttpServer(ctx);

    const res = await postMcp(handle.port, {
      host: `localhost:${handle.port}`,
      body: toolsCallBody('site_check', { site: 'acme' }),
    });

    expect(res.status).toBe(200);
  });

  it('rejects a Host header not on the (expanded) allowed list', async () => {
    const port = await getFreePort();
    const ctx = buildCtx({ MCP_HTTP_PORT: port, MCP_HTTP_ALLOWED_HOSTS: 'localhost' });
    handle = await startHttpServer(ctx);

    const res = await postMcp(handle.port, {
      host: 'evil.example.com',
      body: toolsCallBody('site_check', { site: 'acme' }),
    });

    expect(res.status).toBe(403);
    expect(res.body).toContain('Invalid Host header');
  });

  it('handles two concurrent tools/call requests without "Already connected to a transport"', async () => {
    const port = await getFreePort();
    let inFlight = 0;
    let maxInFlight = 0;
    const ctx = buildCtx(
      { MCP_HTTP_PORT: port, MCP_HTTP_ALLOWED_HOSTS: `127.0.0.1:${port}` },
      createMockFetch(async (url) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        if (url.includes('/wp/v2/users/me')) return jsonResponse({ id: 1, roles: ['administrator'] });
        return jsonResponse({ code: 'rest_no_route', message: 'no' }, { status: 404 });
      }),
    );
    handle = await startHttpServer(ctx);

    const call = () =>
      postMcp(handle!.port, {
        host: `127.0.0.1:${handle!.port}`,
        body: toolsCallBody('site_check', { site: 'acme' }),
      });

    const [r1, r2] = await Promise.all([call(), call()]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body).not.toContain('Already connected');
    expect(r2.body).not.toContain('Already connected');
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });
});
