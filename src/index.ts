import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuditLogger } from './audit.js';
import { envSchema } from './config/schema.js';
import { ConfigError, loadConfig, resolveSitesConfigPath } from './config/loader.js';
import { createServer } from './server.js';
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

  const sitesPath = resolveSitesConfigPath(process.env);
  let appConfig;
  try {
    appConfig = loadConfig(sitesPath, process.env);
  } catch (err) {
    fail(
      err instanceof ConfigError || err instanceof Error ? err.message : String(err),
    );
  }

  const registry = new SiteRegistry(appConfig.sites, { defaultTimeoutMs: env.WP_TIMEOUT_MS });
  const audit = new AuditLogger({ file: env.AUDIT_LOG_FILE });

  const ctx: ToolContext = {
    registry,
    env,
    audit,
    readOnlyGlobal: env.MCP_READ_ONLY,
  };

  const server = createServer(ctx);

  if (env.MCP_TRANSPORT === 'http') {
    if (!env.MCP_HTTP_TOKEN) {
      fail('MCP_HTTP_TOKEN is required when MCP_TRANSPORT=http (min 32 chars)');
    }
    const { startHttpServer } = await import('./http.js');
    startHttpServer(server, ctx);
    return;
  }

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
