import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuditLogger } from '../../src/audit.js';
import type { EnvConfig, ResolvedSite } from '../../src/config/schema.js';
import { createServer } from '../../src/server.js';
import type { ToolContext } from '../../src/tools/context.js';
import type { FetchLike } from '../../src/wp/client.js';
import { SiteRegistry } from '../../src/wp/registry.js';
import { VulnerabilityDb } from '../../src/wp/vulnerabilities.js';

export interface HarnessOptions {
  sites: ResolvedSite[];
  /** Mocked fetch, forwarded to every WpClient the registry creates. */
  fetch?: FetchLike;
  env?: Partial<EnvConfig>;
  readOnlyGlobal?: boolean;
  /** Defaults to a fresh VulnerabilityDb using the mocked fetch (no shared cache between tests). */
  vulnerabilities?: VulnerabilityDb;
}

export interface Harness {
  client: Client;
  ctx: ToolContext;
  /** Every audit line logged during this harness's lifetime, parsed from JSON. */
  auditEntries: Record<string, unknown>[];
  close: () => Promise<void>;
}

const defaultEnv: EnvConfig = {
  SITES_DB: undefined,
  SITES_ENCRYPTION_KEY: undefined,
  MCP_TRANSPORT: 'stdio',
  MCP_HTTP_PORT: 3000,
  MCP_HTTP_HOST: '0.0.0.0',
  MCP_HTTP_TOKEN: undefined,
  MCP_HTTP_ALLOWED_HOSTS: 'localhost,127.0.0.1',
  MCP_READ_ONLY: false,
  WP_TIMEOUT_MS: 30000,
  WP_UPDATE_TIMEOUT_MS: 300000,
  FLEET_CONCURRENCY: 4,
  AUDIT_LOG_FILE: undefined,
};

/**
 * Builds an in-process MCP server + client pair, connected with the SDK's
 * `InMemoryTransport`, so a test can call a registered tool exactly as a real MCP
 * client would (through `client.callTool`), with a mocked `fetch` wired through every
 * `WpClient` the registry creates. This is the one recommended way for any
 * `tests/**` file — core or per-tool-module — to exercise `src/tools/*.ts`.
 *
 * ```ts
 * const harness = await createHarness({ sites: [mySite], fetch: mockFetch });
 * try {
 *   const result = await harness.client.callTool({
 *     name: 'site_check',
 *     arguments: { site: mySite.id },
 *   });
 *   // result.content[0].text is the tool's pretty-printed JSON text.
 *   // harness.auditEntries holds every audit line logged by write tools.
 * } finally {
 *   await harness.close();
 * }
 * ```
 */
export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const auditEntries: Record<string, unknown>[] = [];
  const registry = new SiteRegistry(options.sites, {
    fetch: options.fetch,
    defaultTimeoutMs: options.env?.WP_TIMEOUT_MS ?? defaultEnv.WP_TIMEOUT_MS,
  });
  const audit = new AuditLogger({
    stderrWrite: (line) => {
      auditEntries.push(JSON.parse(line) as Record<string, unknown>);
    },
  });

  const ctx: ToolContext = {
    registry,
    env: { ...defaultEnv, ...options.env },
    audit,
    readOnlyGlobal: options.readOnlyGlobal ?? false,
    vulnerabilities: options.vulnerabilities ?? new VulnerabilityDb({ fetch: options.fetch }),
  };

  const server = createServer(ctx);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wp-fleet-mcp-test-client', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    ctx,
    auditEntries,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export type MockFetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

/** Builds a `Response` with a JSON body — the common shape a mocked WP REST call returns. */
export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** Wraps a handler function as a {@link FetchLike} for `WpClient`'s injectable fetch. */
export function createMockFetch(handler: MockFetchHandler): FetchLike {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  }) as FetchLike;
}

/** Builds a minimal {@link ResolvedSite} for tests, with sensible defaults. */
export function makeSite(overrides: Partial<ResolvedSite> & { id: string }): ResolvedSite {
  return {
    name: overrides.name ?? overrides.id,
    url: overrides.url ?? `https://${overrides.id}.example.com`,
    username: overrides.username ?? 'mcp-bot',
    tags: overrides.tags ?? [],
    readOnly: overrides.readOnly ?? false,
    allowHttp: overrides.allowHttp ?? false,
    bridge: overrides.bridge ?? true,
    healthPaths: overrides.healthPaths ?? [],
    password: overrides.password ?? 'app password 1234',
    available: overrides.available ?? true,
    unavailableReason: overrides.unavailableReason ?? null,
    ...overrides,
  };
}
