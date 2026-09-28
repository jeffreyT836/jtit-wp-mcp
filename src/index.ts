import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuditLogger } from './audit.js';
import { envSchema } from './config/schema.js';
import { createServer } from './server.js';
import { parseEncryptionKey } from './store/crypto.js';
import { resolveSitesDbPath, SiteStore } from './store/site-store.js';
import type { ToolContext } from './tools/context.js';
import { SiteRegistry } from './wp/registry.js';

function fail(message: string): never {
  process.stderr.write(`[wp-fleet-mcp] fatal: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const envResult = envSchema.safeParse(process.env);
  if (!envResult.success) {
    fail(
      `invalid environment configuration: ${envResult.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const env = envResult.data;

  let store: SiteStore;
  try {
    store = new SiteStore(resolveSitesDbPath(process.env), parseEncryptionKey(env.SITES_ENCRYPTION_KEY));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const sites = store.load();
  if (sites.length === 0) {
    process.stderr.write(
      '[wp-fleet-mcp] warning: no sites configured yet; add one with `node dist/cli.js sites add`\n',
    );
  }
  for (const site of sites.filter((s) => !s.available)) {
    process.stderr.write(
      `[wp-fleet-mcp] warning: site "${site.id}" is unavailable: ${site.unavailableReason}\n`,
    );
  }

  const registry = new SiteRegistry(store, { defaultTimeoutMs: env.WP_TIMEOUT_MS });
  const audit = new AuditLogger({ file: env.AUDIT_LOG_FILE });

  const ctx: ToolContext = {
    registry,
    env,
    audit,
    readOnlyGlobal: env.MCP_READ_ONLY,
  };

  if (env.MCP_TRANSPORT === 'http') {
    if (!env.MCP_HTTP_TOKEN) {
      fail('MCP_HTTP_TOKEN is required when MCP_TRANSPORT=http (min 32 chars)');
    }
    const { startHttpServer } = await import('./http.js');
    await startHttpServer(ctx);
    return;
  }

  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[wp-fleet-mcp] stdio server ready\n');
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[wp-fleet-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
