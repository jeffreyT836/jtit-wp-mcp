import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
 * Builds the Express app for `MCP_TRANSPORT=http`: Bearer auth + a stateless Streamable
 * HTTP MCP endpoint at `POST /mcp`, with DNS-rebinding protection via `MCP_HTTP_ALLOWED_HOSTS`.
 * See SPEC.md §1/§2.
 */
export function createHttpApp(server: McpServer, ctx: ToolContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const token = ctx.env.MCP_HTTP_TOKEN;
  if (!token) {
    throw new Error('MCP_HTTP_TOKEN is required when MCP_TRANSPORT=http (min 32 chars)');
  }

  const allowedHosts = ctx.env.MCP_HTTP_ALLOWED_HOSTS.split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post('/mcp', bearerAuth(token), async (req: Request, res: Response) => {
    // Stateless mode: a fresh transport per request, connected to the same server/ctx.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.on('close', () => {
      void transport.close();
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

/** Starts the HTTP transport per SPEC.md §1 (`MCP_HTTP_HOST`/`MCP_HTTP_PORT`). */
export function startHttpServer(server: McpServer, ctx: ToolContext): void {
  const app = createHttpApp(server, ctx);
  app.listen(ctx.env.MCP_HTTP_PORT, ctx.env.MCP_HTTP_HOST, () => {
    process.stderr.write(
      `[wp-fleet-mcp] listening on http://${ctx.env.MCP_HTTP_HOST}:${ctx.env.MCP_HTTP_PORT}\n`,
    );
  });
}
