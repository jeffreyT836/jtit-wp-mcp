/**
 * Shared helpers for `src/tools/<module>.ts`. See SPEC.md §3 and §2 (safety model).
 *
 * ### Read tools
 * ```ts
 * server.registerTool('list_sites', { title, description, inputSchema, annotations: { readOnlyHint: true } },
 *   async (args) => {
 *     try {
 *       const data = await doSomething(args);
 *       return jsonResult(data);
 *     } catch (err) {
 *       return errorResult(err);
 *     }
 *   });
 * ```
 *
 * ### Write tools — use {@link registerWriteTool}
 * `registerWriteTool` is a single entry point that gives every write tool, for free:
 * - it is not registered at all when `ctx.readOnlyGlobal` is true (`MCP_READ_ONLY=true`);
 * - when `args.confirm !== true` it calls `wouldDo(args, site, client)` and returns
 *   `{ dryRun: true, wouldDo }`, without calling `execute` and without any write request;
 * - when confirmed, it calls {@link requireWritable} first, so a per-site `readOnly: true`
 *   site refuses with a clear error and no write is attempted, then calls `execute`;
 * - every *confirmed* attempt (success or failure) is written to `ctx.audit`, redacted.
 *
 * `wouldDo` may be sync or async (return a plain value or a `Promise`), and receives
 * `(args, site, client)` — the `client` param is optional for callers that don't need it,
 * so existing `(args)` / `(args, site)` wouldDo callbacks keep working unchanged. This lets
 * a dry-run preview fetch live state (e.g. current settings, or a self-lockout check) before
 * describing the change. A `wouldDo` that throws — to refuse the call outright (bad input,
 * a missing bridge route, a self-lockout guard) — is never audited as a write attempt (only
 * *confirmed* execute attempts are audited) and produces a plain `errorResult`, exactly like
 * a throwing `execute`.
 *
 * ```ts
 * registerWriteTool(server, ctx, {
 *   name: 'activate_plugin',
 *   title: 'Activate plugin',
 *   description: 'Activates a plugin on a site.',
 *   inputSchema: { site: z.string(), plugin: z.string(), confirm: z.boolean().optional() },
 *   annotations: { destructiveHint: false, idempotentHint: true },
 *   wouldDo: (args) => ({ action: 'activate_plugin', site: args.site, plugin: args.plugin }),
 *   execute: async (args, _site, client) =>
 *     client.request(`/wp/v2/plugins/${args.plugin}`, { method: 'POST', body: { status: 'active' } }),
 * });
 * ```
 *
 * `inputSchema` MUST include a `site: z.string()` field and MAY include
 * `confirm: z.boolean().optional()` (added automatically if omitted is not supported —
 * modules should declare it explicitly for a clear tool description).
 */
import type { McpServer, RegisteredTool, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ResolvedSite } from '../config/schema.js';
import { WpError, sanitizeMessage } from '../wp/errors.js';
import type { WpClient } from '../wp/client.js';
import type { SiteRegistry } from '../wp/registry.js';
import type { ToolContext } from './context.js';

export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Wraps `data` as a single pretty-printed JSON text content item (SPEC.md §3). */
export function jsonResult(data: unknown): ToolTextResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * Wraps a caught error as `isError: true` with a sanitized message — never includes a
 * password or Authorization header (SPEC.md §1/§2).
 */
export function errorResult(err: unknown): ToolTextResult {
  let message: string;
  if (err instanceof WpError) {
    message = err.message;
  } else if (err instanceof Error) {
    message = sanitizeMessage(err.message);
  } else {
    message = sanitizeMessage(String(err));
  }
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Throws when `site.readOnly` is true. Call before any write against that site. */
export function requireWritable(site: ResolvedSite): void {
  if (site.readOnly) {
    throw new Error(`site "${site.id}" is configured read-only; write operations are refused`);
  }
}

/**
 * Returns a dry-run preview object when `confirm !== true`, else `null` (proceed).
 * `wouldDo` is only invoked when a preview is actually needed.
 */
export function confirmGuard<T>(
  confirm: boolean | undefined,
  wouldDo: () => T,
): { dryRun: true; wouldDo: T } | null {
  if (confirm === true) return null;
  return { dryRun: true, wouldDo: wouldDo() };
}

export interface FleetResult<T> {
  site: string;
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Runs `fn` for every site in `sites` with at most `concurrency` in flight at once.
 * Never rejects: each site's outcome is captured as one {@link FleetResult}.
 */
export async function runFleet<T>(
  sites: ResolvedSite[],
  fn: (site: ResolvedSite) => Promise<T>,
  concurrency: number,
): Promise<FleetResult<T>[]> {
  const results: FleetResult<T>[] = new Array(sites.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, sites.length || 1));

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= sites.length) return;
      const site = sites[i]!;
      try {
        const data = await fn(site);
        results[i] = { site: site.id, ok: true, data };
      } catch (err) {
        results[i] = {
          site: site.id,
          ok: false,
          error:
            err instanceof WpError
              ? err.message
              : err instanceof Error
                ? sanitizeMessage(err.message)
                : sanitizeMessage(String(err)),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export interface SiteFilter {
  sites?: string[];
  tags?: string[];
}

/** One site excluded from a fleet-tool run because it is unavailable, with the reason why. */
export interface SkippedSite {
  site: string;
  reason: string;
}

export interface SiteSelection {
  /** Available sites the fleet tool should actually contact. */
  selected: ResolvedSite[];
  /** Sites matching the filter that were excluded because `site.available` is false. */
  skipped: SkippedSite[];
}

/**
 * Resolves a fleet tool's `{ sites?, tags? }` filter to a concrete list of sites. With no
 * filter, considers every configured site (SPEC.md §4). An unknown site id in an explicit
 * `sites` list still throws (via {@link SiteRegistry.get}) — that is a caller mistake, not
 * an unavailable site. An *unavailable* site (missing secret, insecure URL) is never
 * contacted, whether it came from an explicit `sites` list or the default "every site":
 * it is excluded from `selected` and reported in `skipped` so fleet tools can surface it in
 * their summary instead of silently dropping it or failing the whole call.
 */
export function selectSites(registry: SiteRegistry, filter: SiteFilter = {}): SiteSelection {
  const explicitSites = filter.sites && filter.sites.length > 0;
  const base = explicitSites ? filter.sites!.map((id) => registry.get(id)) : registry.list();
  const tagged =
    filter.tags && filter.tags.length > 0
      ? base.filter((site) => filter.tags!.every((tag) => site.tags.includes(tag)))
      : base;
  const selected = tagged.filter((site) => site.available);
  const skipped = tagged
    .filter((site) => !site.available)
    .map((site) => ({ site: site.id, reason: site.unavailableReason ?? 'site is unavailable' }));
  return { selected, skipped };
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export interface WriteToolConfig<Shape extends ZodRawShapeCompat> {
  name: string;
  title: string;
  description: string;
  /** Must include `site: z.string()`; should include `confirm: z.boolean().optional()`. */
  inputSchema: Shape;
  annotations?: ToolAnnotations;
  /**
   * Builds the object returned as `wouldDo` in the dry-run preview. May be sync or async,
   * and may use `client` to fetch live state for an accurate preview (e.g. current -> new
   * values, or a self-lockout guard check). Only called when `args.confirm !== true`.
   * A thrown error here is reported as an `errorResult` and is never audited.
   */
  wouldDo: (args: ShapeOutput<Shape>, site: ResolvedSite, client: WpClient) => unknown | Promise<unknown>;
  /** Performs the actual write. Only called once confirmed and the site is writable. */
  execute: (args: ShapeOutput<Shape>, site: ResolvedSite, client: WpClient) => Promise<unknown>;
}

/**
 * Registers a write tool with the confirm/dry-run/readOnly/audit behavior described in
 * the module doc comment above. No-op when `ctx.readOnlyGlobal` is true, per SPEC.md §2.3.
 */
export function registerWriteTool<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  ctx: ToolContext,
  config: WriteToolConfig<Shape>,
): RegisteredTool | undefined {
  if (ctx.readOnlyGlobal) return undefined;

  const handler: ToolCallback<Shape> = (async (args: ShapeOutput<Shape>) => {
    const siteId = String((args as Record<string, unknown>).site ?? '');
    const confirmed = (args as Record<string, unknown>).confirm === true;
    try {
      const site = ctx.registry.get(siteId);
      const client = ctx.registry.client(siteId);
      if (!confirmed) {
        const wouldDo = await config.wouldDo(args, site, client);
        return jsonResult({ dryRun: true, wouldDo });
      }
      requireWritable(site);
      const data = await config.execute(args, site, client);
      ctx.audit.log({ tool: config.name, site: siteId, args, ok: true });
      return jsonResult(data);
    } catch (err) {
      if (confirmed) {
        ctx.audit.log({
          tool: config.name,
          site: siteId,
          args,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return errorResult(err);
    }
  }) as unknown as ToolCallback<Shape>;

  return server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: { readOnlyHint: false, ...config.annotations },
    },
    handler,
  );
}
