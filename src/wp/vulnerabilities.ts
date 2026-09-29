import type { ResolvedSite } from '../config/schema.js';
import { fetchPlugins } from '../tools/plugins.js';
import { fetchThemes } from '../tools/themes.js';
import type { FetchLike, WpClient } from './client.js';
import { sanitizeMessage } from './errors.js';

/**
 * Known-vulnerability lookup against WPVulnerability (https://www.wpvulnerability.com), a
 * free database without API key that aggregates CVE, Wordfence, Patchstack and WPScan data.
 *
 * Only public component identifiers (a wordpress.org slug, or a core version number) are
 * sent to this one fixed host — never a site URL, user or credential.
 */
export const WPVULNERABILITY_API = 'https://www.wpvulnerability.net';

const LOOKUP_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5000;
const LOOKUP_CONCURRENCY = 4;

export type ComponentType = 'core' | 'plugin' | 'theme';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown'];

export interface Vulnerability {
  id: string;
  name: string;
  severity: Severity;
  score?: number;
  /** Human-readable affected range, e.g. "≥ 1.0 – < 5.8.4". */
  affected: string;
  /** First version without this vulnerability, when the database knows one. */
  fixedIn?: string;
  /** No fixed version exists (yet). */
  unfixed: boolean;
  references: Array<{ name: string; url: string }>;
}

export interface ComponentFinding {
  type: ComponentType;
  slug: string;
  name?: string;
  version: string;
  /** Plugin/theme status on the site ("active", "inactive", …); absent for core. */
  status?: string;
  vulnerabilities: Vulnerability[];
}

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  total: number;
}

export interface SiteVulnerabilityReport {
  checked_at: string;
  checked: { core: boolean; plugins: number; themes: number };
  /** Only components with at least one vulnerability that applies to the installed version. */
  findings: ComponentFinding[];
  /** Counts vulnerabilities (not components). */
  summary: SeverityCounts;
  /** Components that could not be looked up; their absence from `findings` means "unknown", not "safe". */
  errors: Array<{ type: ComponentType; slug: string; error: string }>;
}

/** Raw vulnerability entry as WPVulnerability returns it. */
interface RawVulnerability {
  uuid?: string;
  name?: string;
  operator?: {
    min_version?: string | null;
    min_operator?: string | null;
    max_version?: string | null;
    max_operator?: string | null;
    unfixed?: string | number | null;
  } | null;
  source?: Array<{ id?: string; name?: string; link?: string }> | null;
  impact?: { cvss?: { score?: string | number; severity?: string } | null } | null;
}

interface RawResponse {
  error?: number | string | boolean;
  data?: { vulnerability?: RawVulnerability[] | null } | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;

/** A plugin's wordpress.org slug: its directory, or the file name for single-file plugins. */
export function pluginSlug(pluginFile: string): string {
  const [dir] = pluginFile.split('/');
  return (dir ?? '').replace(/\.php$/, '').toLowerCase();
}

// --- PHP version_compare(), which WPVulnerability's ranges are defined against ---

const SPECIAL: Record<string, number> = { dev: 0, alpha: 1, a: 1, beta: 2, b: 2, RC: 3, rc: 3, '#': 4, pl: 5, p: 5 };

function canonical(version: string): string[] {
  return version
    .replace(/[-_+]/g, '.')
    .replace(/([^.\d]+)(\d)/g, '$1.$2')
    .replace(/(\d)([^.\d]+)/g, '$1.$2')
    .split('.')
    .filter((part) => part !== '');
}

function partOrder(part: string): number {
  if (/^\d+$/.test(part)) return 10; // numbers sort after every special string
  return SPECIAL[part] ?? -1; // unknown strings sort before "dev"
}

/** Port of PHP's version_compare(a, b): -1, 0 or 1. */
export function versionCompare(a: string, b: string): number {
  const pa = canonical(a);
  const pb = canonical(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined || y === undefined) {
      // PHP: a missing part compares like "#" against a special string, else the longer wins.
      const present = (x ?? y)!;
      const sign = x === undefined ? -1 : 1;
      if (/^\d+$/.test(present)) return sign;
      return partOrder(present) < SPECIAL['#']! ? -sign : sign;
    }
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    const d = partOrder(x) - partOrder(y);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function compareWith(version: string, target: string, operator: string): boolean {
  const c = versionCompare(version, target);
  switch (operator.toLowerCase()) {
    case 'lt':
    case '<':
      return c < 0;
    case 'le':
    case '<=':
      return c <= 0;
    case 'gt':
    case '>':
      return c > 0;
    case 'ge':
    case '>=':
      return c >= 0;
    case 'eq':
    case '==':
      return c === 0;
    case 'ne':
    case '!=':
      return c !== 0;
    default:
      return false;
  }
}

/** Mirrors WPVulnerability's own applicability check (min and/or max bound). */
export function isAffected(version: string, operator: RawVulnerability['operator']): boolean {
  if (!operator) return false;
  const { min_version: minV, min_operator: minOp, max_version: maxV, max_operator: maxOp } = operator;
  const hasMin = !!minOp && !!minV;
  const hasMax = !!maxOp && !!maxV;
  if (hasMin && hasMax) return compareWith(version, minV!, minOp!) && compareWith(version, maxV!, maxOp!);
  if (hasMax) return compareWith(version, maxV!, maxOp!);
  if (hasMin) return compareWith(version, minV!, minOp!);
  return false;
}

const OP_SYMBOL: Record<string, string> = { lt: '<', le: '≤', gt: '>', ge: '≥', eq: '=', ne: '≠' };

function rangeText(operator: RawVulnerability['operator']): string {
  if (!operator) return 'alle versies';
  const part = (op?: string | null, v?: string | null) => (op && v ? `${OP_SYMBOL[op.toLowerCase()] ?? op} ${v}` : null);
  return [part(operator.min_operator, operator.min_version), part(operator.max_operator, operator.max_version)]
    .filter(Boolean)
    .join(' – ') || 'alle versies';
}

function severityOf(impact: RawVulnerability['impact']): { severity: Severity; score?: number } {
  const rawScore = impact?.cvss?.score;
  const score = rawScore === undefined || rawScore === null || rawScore === '' ? undefined : Number(rawScore);
  const letter = String(impact?.cvss?.severity ?? '').trim().toLowerCase();
  const byLetter: Record<string, Severity> = { c: 'critical', h: 'high', m: 'medium', l: 'low', n: 'low' };
  let severity: Severity = byLetter[letter] ?? 'unknown';
  if (severity === 'unknown' && score !== undefined && Number.isFinite(score)) {
    severity = score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
  }
  return { severity, ...(score !== undefined && Number.isFinite(score) ? { score } : {}) };
}

function toVulnerability(raw: RawVulnerability): Vulnerability {
  const op = raw.operator ?? null;
  const unfixed = String(op?.unfixed ?? '0') === '1';
  const maxOp = op?.max_operator?.toLowerCase();
  // "< X" means X is the first fixed release; "≤ X" only says X is still affected.
  const fixedIn = !unfixed && maxOp === 'lt' && op?.max_version ? op.max_version : undefined;
  const references = (raw.source ?? [])
    .filter((s) => typeof s.link === 'string' && /^https:\/\//i.test(s.link))
    .map((s) => ({ name: String(s.id ?? s.name ?? 'bron'), url: s.link! }));
  return {
    id: String(raw.uuid ?? raw.source?.[0]?.id ?? raw.name ?? 'onbekend'),
    name: String(raw.name ?? 'Onbekende kwetsbaarheid').replace(/<[^>]*>/g, '').trim(),
    ...severityOf(raw.impact),
    affected: rangeText(op),
    ...(fixedIn ? { fixedIn } : {}),
    unfixed,
    references,
  };
}

const bySeverity = (a: Vulnerability, b: Vulnerability) =>
  SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || (b.score ?? 0) - (a.score ?? 0);

export function emptyCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, total: 0 };
}

/** Worst severity among a component's vulnerabilities. */
export function worstSeverity(vulns: Array<{ severity: Severity }>): Severity {
  return SEVERITY_ORDER.find((s) => vulns.some((v) => v.severity === s)) ?? 'unknown';
}

export interface VulnerabilityDbOptions {
  fetch?: FetchLike;
  ttlMs?: number;
  timeoutMs?: number;
  baseUrl?: string;
}

/**
 * Cached client for the WPVulnerability API. One instance per process: fleet scans look up
 * each unique slug once, and results are kept for six hours.
 */
export class VulnerabilityDb {
  private readonly cache = new Map<string, { at: number; value: Promise<RawVulnerability[]> }>();
  private readonly fetchImpl: FetchLike;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(options: VulnerabilityDbOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
    this.baseUrl = options.baseUrl ?? WPVULNERABILITY_API;
  }

  /** Raw vulnerabilities for a plugin/theme slug, or for a core version. Throws on API failure. */
  lookup(type: ComponentType, id: string): Promise<RawVulnerability[]> {
    const valid = type === 'core' ? VERSION_RE.test(id) : SLUG_RE.test(id);
    if (!valid) return Promise.reject(new Error(`ongeldige ${type === 'core' ? 'versie' : 'slug'}: ${JSON.stringify(id)}`));
    const key = `${type}:${id}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const value = this.limited(() => this.request(type, id));
    // Failed lookups are not cached, so the next scan retries them.
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: now, value });
    return value;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= LOOKUP_CONCURRENCY) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }

  private async request(type: ComponentType, id: string): Promise<RawVulnerability[]> {
    const url = `${this.baseUrl}/${type}/${encodeURIComponent(id)}/`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'wp-fleet-mcp' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`WPVulnerability niet bereikbaar: ${sanitizeMessage(err instanceof Error ? err.message : String(err))}`);
    }
    // Unknown slug (e.g. a premium or custom plugin): nothing known, not an error.
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`WPVulnerability antwoordde met HTTP ${res.status}`);
    let body: RawResponse;
    try {
      body = (await res.json()) as RawResponse;
    } catch {
      throw new Error('WPVulnerability gaf een ongeldig antwoord');
    }
    const list = body?.data?.vulnerability;
    return Array.isArray(list) ? list : [];
  }
}

interface Component {
  type: ComponentType;
  slug: string;
  name?: string;
  version: string;
  status?: string;
}

/** Looks up components and keeps only the vulnerabilities that apply to the installed version. */
export async function scanComponents(db: VulnerabilityDb, components: Component[]): Promise<Pick<SiteVulnerabilityReport, 'findings' | 'summary' | 'errors'>> {
  const findings: ComponentFinding[] = [];
  const errors: SiteVulnerabilityReport['errors'] = [];
  const summary = emptyCounts();
  await Promise.all(
    components.map(async (c) => {
      const lookupId = c.type === 'core' ? c.version : c.slug;
      try {
        const raw = await db.lookup(c.type, lookupId);
        // The core endpoint is per version already; entries without a range apply as-is.
        const applicable = raw.filter((v) => (c.type === 'core' && !v.operator?.max_operator && !v.operator?.min_operator) || isAffected(c.version, v.operator));
        if (applicable.length === 0) return;
        const vulnerabilities = applicable.map(toVulnerability).sort(bySeverity);
        for (const v of vulnerabilities) {
          summary[v.severity] += 1;
          summary.total += 1;
        }
        findings.push({ ...c, vulnerabilities });
      } catch (err) {
        errors.push({ type: c.type, slug: c.slug, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
  findings.sort((a, b) => bySeverity(a.vulnerabilities[0]!, b.vulnerabilities[0]!) || a.slug.localeCompare(b.slug));
  return { findings, summary, errors };
}

/**
 * Scans one site: installed plugins and themes via WP REST, core via nb-mcp-bridge
 * `/status` (core REST does not expose the WordPress version). Components with a slug or
 * version that is not a plain identifier are skipped, never sent.
 */
export async function scanSite(client: WpClient, site: ResolvedSite, db: VulnerabilityDb): Promise<SiteVulnerabilityReport> {
  const [plugins, themes, coreVersion] = await Promise.all([
    fetchPlugins(client),
    fetchThemes(client),
    site.bridge !== false
      ? client.bridge<{ wp_version?: string }>('/status').then((s) => s.wp_version, () => undefined)
      : Promise.resolve(undefined),
  ]);
  const components: Component[] = [];
  if (coreVersion && VERSION_RE.test(coreVersion)) {
    components.push({ type: 'core', slug: 'wordpress', name: 'WordPress', version: coreVersion });
  }
  for (const p of plugins) {
    const slug = pluginSlug(p.plugin);
    if (p.version && SLUG_RE.test(slug) && VERSION_RE.test(p.version)) {
      components.push({ type: 'plugin', slug, name: p.name, version: p.version, status: p.status });
    }
  }
  for (const t of themes) {
    const slug = t.stylesheet.toLowerCase();
    if (t.version && SLUG_RE.test(slug) && VERSION_RE.test(t.version)) {
      components.push({ type: 'theme', slug, name: t.name, version: t.version, status: t.status });
    }
  }
  const result = await scanComponents(db, components);
  return {
    checked_at: new Date().toISOString(),
    checked: {
      core: components.some((c) => c.type === 'core'),
      plugins: components.filter((c) => c.type === 'plugin').length,
      themes: components.filter((c) => c.type === 'theme').length,
    },
    ...result,
  };
}

let sharedDb: VulnerabilityDb | undefined;

/** Process-wide default instance (shared cache) for callers without an injected one. */
export function defaultVulnerabilityDb(): VulnerabilityDb {
  sharedDb ??= new VulnerabilityDb();
  return sharedDb;
}
