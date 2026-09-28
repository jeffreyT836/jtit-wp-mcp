import type { Server as NodeHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import type { ToolContext } from './tools/context.js';

/** Constant-time comparison of a bearer token against the configured secret. */
function timingSafeTokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still run a comparison of equal length to avoid leaking length via early return timing.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function bearerAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !timingSafeTokenEquals(match[1] ?? '', token)) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'unauthorized' },
        id: null,
      });
      return;
    }
    next();
  };
}

/**
 * Expands `MCP_HTTP_ALLOWED_HOSTS` for the SDK's exact-match `Host` header check
 * (`enableDnsRebindingProtection`). A bare entry (no `:port` of its own, e.g. "localhost")
 * is accepted both on its own and as `<entry>:<port>` for the server's own configured
 * `MCP_HTTP_PORT`, since browsers/clients normally send `Host: <name>:<port>` and the SDK
 * requires an exact string match. An entry that already carries a port (e.g. "example.com:8443")
 * is kept exactly as given and is not modified — that form matters when a reverse proxy or a
 * Docker port mapping exposes this server under a *different* host-side port than the one
 * it listens on internally, in which case the operator must list that external port
 * explicitly (see README §3.3/§4.2 for the Docker port-mapping caveat).
 */
export function expandAllowedHosts(raw: string, port: number): string[] {
  const entries = raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const expanded = new Set<string>();
  for (const entry of entries) {
    expanded.add(entry);
    if (!entry.includes(':')) {
      expanded.add(`${entry}:${port}`);
    }
  }
  return [...expanded];
}

/**
 * Builds the Express app for `MCP_TRANSPORT=http`: Bearer auth + a stateless Streamable
 * HTTP MCP endpoint at `POST /mcp`, with DNS-rebinding protection via `MCP_HTTP_ALLOWED_HOSTS`.
 * See SPEC.md §1/§2.
 *
 * Stateless mode means each request gets its own {@link McpServer} + transport pair (the SDK's
 * documented stateless pattern), not one shared server reused across requests — a shared
 * server can only ever be connected to one transport at a time, so a second concurrent
 * `tools/call` would fail with "Already connected to a transport". Both are closed when the
 * response closes.
 */
export function createHttpApp(ctx: ToolContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const token = ctx.env.MCP_HTTP_TOKEN;
  if (!token) {
    throw new Error('MCP_HTTP_TOKEN is required when MCP_TRANSPORT=http (min 32 chars)');
  }

  const allowedHosts = expandAllowedHosts(ctx.env.MCP_HTTP_ALLOWED_HOSTS, ctx.env.MCP_HTTP_PORT);

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post('/mcp', bearerAuth(token), async (req: Request, res: Response) => {
    // Stateless mode: a fresh McpServer + transport per request.
    const server = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Plain JSON responses (allowed by the spec) so simple HTTP clients such as n8n can
      // read results without parsing an SSE stream.
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      process.stderr.write(
        `[wp-fleet-mcp] http request failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'internal error' },
          id: null,
        });
      }
    }
  });

  return app;
}

export interface HttpServerHandle {
  /** The port actually bound (matches `MCP_HTTP_PORT` unless it was 0, e.g. in tests). */
  port: number;
  close: () => Promise<void>;
}

/**
 * Starts the HTTP transport per SPEC.md §1 (`MCP_HTTP_HOST`/`MCP_HTTP_PORT`), and resolves
 * once it is actually listening. Returns a handle with the bound port and a `close()` to stop
 * it — used by `src/index.ts` for the real server, and by `tests/core/http.test.ts` to start
 * one on an ephemeral/test port and tear it down afterwards.
 */
export function startHttpServer(ctx: ToolContext): Promise<HttpServerHandle> {
  const app = createHttpApp(ctx);
  return new Promise((resolve) => {
    const httpServer: NodeHttpServer = app.listen(ctx.env.MCP_HTTP_PORT, ctx.env.MCP_HTTP_HOST, () => {
      const address = httpServer.address();
      const port = address && typeof address === 'object' ? address.port : ctx.env.MCP_HTTP_PORT;
      process.stderr.write(`[wp-fleet-mcp] listening on http://${ctx.env.MCP_HTTP_HOST}:${port}\n`);
      resolve({
        port,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            httpServer.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}
