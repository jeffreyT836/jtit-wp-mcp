import { appendFileSync } from 'node:fs';
import { sanitizeMessage } from './wp/errors.js';

export interface AuditEntry {
  ts: string;
  tool: string;
  site: string;
  args: unknown;
  ok: boolean;
  error?: string;
}

const SECRET_KEYS = new Set(['password', 'passwordenv', 'secret', 'authorization', 'token']);

/** Deep-clones `value`, replacing any key that looks like a secret with `"[redacted]"`. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(val);
    }
    return out;
  }
  if (typeof value === 'string') {
    return sanitizeMessage(value);
  }
  return value;
}

export interface AuditLoggerOptions {
  /** Optional JSONL file to also append entries to, per SPEC.md §1 `AUDIT_LOG_FILE`. */
  file?: string;
  /** Overridable for tests; defaults to writing one JSON line to stderr. */
  stderrWrite?: (line: string) => void;
}

/**
 * Logs every confirmed write attempt as one redacted JSON line to stderr (never stdout —
 * stdout is the stdio MCP channel) and, if configured, to `AUDIT_LOG_FILE`. See SPEC.md §2.5.
 */
export class AuditLogger {
  private readonly file: string | undefined;
  private readonly stderrWrite: (line: string) => void;

  constructor(options: AuditLoggerOptions = {}) {
    this.file = options.file;
    this.stderrWrite = options.stderrWrite ?? ((line) => process.stderr.write(line));
  }

  log(entry: Omit<AuditEntry, 'ts'>): void {
    const full: AuditEntry = {
      ts: new Date().toISOString(),
      tool: entry.tool,
      site: entry.site,
      args: redact(entry.args),
      ok: entry.ok,
      ...(entry.error !== undefined ? { error: sanitizeMessage(entry.error) } : {}),
    };
    const line = `${JSON.stringify(full)}\n`;
    this.stderrWrite(line);
    if (this.file) {
      try {
        appendFileSync(this.file, line);
      } catch (err) {
        process.stderr.write(
          `[wp-fleet-mcp] failed to write audit log file ${this.file}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
}
