import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuditLogger } from '../../src/audit.js';
import type { EnvConfig, ResolvedSite } from '../../src/config/schema.js';
import type { ToolContext } from '../../src/tools/context.js';
import {
  confirmGuard,
  errorResult,
  jsonResult,
  registerWriteTool,
  requireWritable,
  runFleet,
  selectSites,
} from '../../src/tools/helpers.js';
import type { FetchLike } from '../../src/wp/client.js';
import { WpError } from '../../src/wp/errors.js';
import { SiteRegistry } from '../../src/wp/registry.js';
import { createMockFetch, jsonResponse, makeSite } from '../helpers/harness.js';

const testEnv: EnvConfig = {
  SITES_CONFIG: undefined,
  MCP_TRANSPORT: 'stdio',
  MCP_HTTP_PORT: 3000,
  MCP_HTTP_HOST: '0.0.0.0',
  MCP_HTTP_TOKEN: undefined,
  MCP_HTTP_ALLOWED_HOSTS: 'localhost',
  MCP_READ_ONLY: false,
  WP_TIMEOUT_MS: 30000,
  WP_UPDATE_TIMEOUT_MS: 300000,
  FLEET_CONCURRENCY: 4,
  AUDIT_LOG_FILE: undefined,
};

/** Builds a standalone MCP server/client pair with one `noop_write` tool registered via registerWriteTool. */
async function buildWriteToolHarness(options: {
  sites: ResolvedSite[];
  fetch?: FetchLike;
  readOnlyGlobal?: boolean;
  wouldDo?: (args: { site: string; confirm?: boolean }, site: ResolvedSite, client: unknown) => unknown;
  execute?: (args: { site: string; confirm?: boolean }, site: ResolvedSite, client: unknown) => Promise<unknown>;
}) {
  const registry = new SiteRegistry(options.sites, { fetch: options.fetch });
  const auditEntries: Record<string, unknown>[] = [];
  const audit = new AuditLogger({
    stderrWrite: (line) => auditEntries.push(JSON.parse(line) as Record<string, unknown>),
  });
  const ctx: ToolContext = {
    registry,
    env: testEnv,
    audit,
    readOnlyGlobal: options.readOnlyGlobal ?? false,
  };

  let executed = false;
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  // Always-registered read tool so `tools/list` works even when noop_write is skipped
  // (readOnlyGlobal), letting the test assert its absence rather than a bare protocol error.
  server.registerTool(
    'ping',
    { title: 'Ping', description: 'test', inputSchema: {} },
    async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
  );
  registerWriteTool(server, ctx, {
    name: 'noop_write',
    title: 'Noop write',
    description: 'test write tool',
    inputSchema: { site: z.string(), confirm: z.boolean().optional() },
    wouldDo: (args, site, client) =>
      options.wouldDo ? options.wouldDo(args, site, client) : { action: 'noop', site: args.site },
    execute: async (args, site, client) => {
      executed = true;
      if (options.execute) return options.execute(args, site, client);
      return { done: true };
    },
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    auditEntries,
    wasExecuted: () => executed,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('jsonResult / errorResult', () => {
  it('jsonResult wraps data as pretty-printed JSON text', () => {
    const result = jsonResult({ a: 1 });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }]);
  });

  it('errorResult marks isError and sanitizes plain Error messages', () => {
    const result = errorResult(new Error('failed with Authorization: Basic abc123'));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain('abc123');
  });

  it('errorResult passes through an already-sanitized WpError message', () => {
    const err = new WpError({ status: 500, code: 'x', message: 'boom', site: 's1' });
    const result = errorResult(err);
    expect(result.content[0]?.text).toBe('boom');
  });
});

describe('requireWritable', () => {
  it('throws for a readOnly site', () => {
    const site = makeSite({ id: 's1', readOnly: true });
    expect(() => requireWritable(site)).toThrow(/read-only/);
  });

  it('does not throw for a writable site', () => {
    const site = makeSite({ id: 's1', readOnly: false });
    expect(() => requireWritable(site)).not.toThrow();
  });
});

describe('confirmGuard', () => {
  it('returns a dry-run preview when confirm is not true', () => {
    const guard = confirmGuard(undefined, () => ({ action: 'x' }));
    expect(guard).toEqual({ dryRun: true, wouldDo: { action: 'x' } });
  });

  it('returns null (proceed) when confirm is true', () => {
    const guard = confirmGuard(true, () => ({ action: 'x' }));
    expect(guard).toBeNull();
  });

  it('does not evaluate wouldDo when confirmed', () => {
    let called = false;
    confirmGuard(true, () => {
      called = true;
      return {};
    });
    expect(called).toBe(false);
  });
});

describe('runFleet', () => {
  it('never rejects and captures per-site success/failure', async () => {
    const sites = [makeSite({ id: 'ok' }), makeSite({ id: 'bad' }), makeSite({ id: 'ok2' })];
    const results = await runFleet(
      sites,
      async (site) => {
        if (site.id === 'bad') throw new Error('boom');
        return { site: site.id };
      },
      2,
    );

    expect(results).toHaveLength(3);
    expect(results.find((r) => r.site === 'ok')).toMatchObject({ ok: true, data: { site: 'ok' } });
    expect(results.find((r) => r.site === 'bad')).toMatchObject({ ok: false, error: 'boom' });
    expect(results.find((r) => r.site === 'ok2')).toMatchObject({ ok: true });
  });

  it('respects the concurrency limit', async () => {
    const sites = Array.from({ length: 5 }, (_, i) => makeSite({ id: `s${i}` }));
    let inFlight = 0;
    let maxInFlight = 0;
    await runFleet(
      sites,
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return null;
      },
      2,
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

describe('selectSites', () => {
  it('defaults to all available sites when no filter is given', () => {
    const registry = new SiteRegistry([
      makeSite({ id: 'a', available: true }),
      makeSite({ id: 'b', available: false, unavailableReason: 'no secret' }),
    ]);
    const selected = selectSites(registry);
    expect(selected.map((s) => s.id)).toEqual(['a']);
  });

  it('honors an explicit sites list even if unavailable', () => {
    const registry = new SiteRegistry([makeSite({ id: 'a', available: false, unavailableReason: 'x' })]);
    const selected = selectSites(registry, { sites: ['a'] });
    expect(selected.map((s) => s.id)).toEqual(['a']);
  });

  it('filters by tags', () => {
    const registry = new SiteRegistry([
      makeSite({ id: 'a', tags: ['prod'] }),
      makeSite({ id: 'b', tags: ['staging'] }),
    ]);
    expect(selectSites(registry, { tags: ['prod'] }).map((s) => s.id)).toEqual(['a']);
  });
});

describe('registerWriteTool', () => {
  it('is not registered at all when ctx.readOnlyGlobal is true', async () => {
    const site = makeSite({ id: 's1' });
    const harness = await buildWriteToolHarness({ sites: [site], readOnlyGlobal: true });
    try {
      const { tools } = await harness.client.listTools();
      expect(tools.find((t) => t.name === 'noop_write')).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('returns a dry-run preview and does not call execute when confirm is not true', async () => {
    const site = makeSite({ id: 's1' });
    const harness = await buildWriteToolHarness({ sites: [site] });
    try {
      const result = await harness.client.callTool({ name: 'noop_write', arguments: { site: 's1' } });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(harness.wasExecuted()).toBe(false);
      expect(JSON.parse(text)).toEqual({ dryRun: true, wouldDo: { action: 'noop', site: 's1' } });
      expect(harness.auditEntries).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('refuses a confirmed write against a readOnly site, without executing, and audits it', async () => {
    const site = makeSite({ id: 's1', readOnly: true });
    const harness = await buildWriteToolHarness({ sites: [site] });
    try {
      const result = await harness.client.callTool({ name: 'noop_write', arguments: { site: 's1', confirm: true } });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;

      expect(harness.wasExecuted()).toBe(false);
      expect(result.isError).toBe(true);
      expect(text).toMatch(/read-only/);
      expect(harness.auditEntries).toHaveLength(1);
      expect(harness.auditEntries[0]).toMatchObject({ tool: 'noop_write', site: 's1', ok: false });
    } finally {
      await harness.close();
    }
  });

  it('executes and audits a confirmed write on a writable site', async () => {
    const site = makeSite({ id: 's1' });
    const harness = await buildWriteToolHarness({
      sites: [site],
      fetch: createMockFetch(() => jsonResponse({ ok: true })),
      execute: async (_args, _site, client) =>
        (client as { request: (path: string) => Promise<unknown> }).request('/wp/v2/plugins'),
    });
    try {
      const result = await harness.client.callTool({ name: 'noop_write', arguments: { site: 's1', confirm: true } });

      expect(harness.wasExecuted()).toBe(true);
      expect(result.isError).toBeUndefined();
      expect(harness.auditEntries).toHaveLength(1);
      expect(harness.auditEntries[0]).toMatchObject({ tool: 'noop_write', site: 's1', ok: true });
    } finally {
      await harness.close();
    }
  });

  it('supports an async wouldDo and awaits it for the dry-run preview', async () => {
    const site = makeSite({ id: 's1' });
    const harness = await buildWriteToolHarness({
      sites: [site],
      wouldDo: async (args) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { action: 'noop', site: args.site, fetched: true };
      },
    });
    try {
      const result = await harness.client.callTool({ name: 'noop_write', arguments: { site: 's1' } });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;

      expect(harness.wasExecuted()).toBe(false);
      expect(JSON.parse(text)).toEqual({ dryRun: true, wouldDo: { action: 'noop', site: 's1', fetched: true } });
      expect(harness.auditEntries).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('returns an errorResult and does not audit when wouldDo throws (unconfirmed)', async () => {
    const site = makeSite({ id: 's1' });
    const harness = await buildWriteToolHarness({
      sites: [site],
      wouldDo: () => {
        throw new Error('refusing: self-lockout guard tripped');
      },
    });
    try {
      const result = await harness.client.callTool({ name: 'noop_write', arguments: { site: 's1' } });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;

      expect(harness.wasExecuted()).toBe(false);
      expect(result.isError).toBe(true);
      expect(text).toMatch(/self-lockout guard tripped/);
      expect(harness.auditEntries).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('returns an errorResult and does not audit when an async wouldDo rejects (unconfirmed)', async () => {
    const site = makeSite({ id: 's1' });
    const harness = await buildWriteToolHarness({
      sites: [site],
      wouldDo: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error('bridge route missing');
      },
    });
    try {
      const result = await harness.client.callTool({ name: 'noop_write', arguments: { site: 's1' } });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;

      expect(harness.wasExecuted()).toBe(false);
      expect(result.isError).toBe(true);
      expect(text).toMatch(/bridge route missing/);
      expect(harness.auditEntries).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('still audits a confirmed attempt that fails in execute, even though wouldDo is never called', async () => {
    const site = makeSite({ id: 's1' });
    let wouldDoCalled = false;
    const harness = await buildWriteToolHarness({
      sites: [site],
      wouldDo: (args) => {
        wouldDoCalled = true;
        return { action: 'noop', site: args.site };
      },
      execute: async () => {
        throw new Error('execute failed');
      },
    });
    try {
      const result = await harness.client.callTool({ name: 'noop_write', arguments: { site: 's1', confirm: true } });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;

      expect(wouldDoCalled).toBe(false);
      expect(result.isError).toBe(true);
      expect(text).toMatch(/execute failed/);
      expect(harness.auditEntries).toHaveLength(1);
      expect(harness.auditEntries[0]).toMatchObject({ tool: 'noop_write', site: 's1', ok: false });
    } finally {
      await harness.close();
    }
  });
});
