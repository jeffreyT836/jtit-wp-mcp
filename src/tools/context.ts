import type { AuditLogger } from '../audit.js';
import type { EnvConfig } from '../config/schema.js';
import type { SiteRegistry } from '../wp/registry.js';
import type { VulnerabilityDb } from '../wp/vulnerabilities.js';

/**
 * Shared context passed to every `src/tools/<module>.ts`'s `register(server, ctx)`.
 * See SPEC.md §3.
 */
export interface ToolContext {
  registry: SiteRegistry;
  env: EnvConfig;
  audit: AuditLogger;
  /** True when `MCP_READ_ONLY=true` — write tools must not be registered at all. */
  readOnlyGlobal: boolean;
  /** Known-vulnerability lookups (shared cache); defaults to the process-wide instance. */
  vulnerabilities?: VulnerabilityDb;
}
