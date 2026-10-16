/**
 * WordPress-style version comparison, modelled on PHP's `version_compare()` (which is what
 * WordPress and the Wordfence feed use), with one deliberate difference: missing trailing
 * segments count as 0, so "6.5" equals "6.5.0".
 */

/** Rank of non-numeric segments, as in PHP: unknown < dev < alpha < beta < RC < number < pl. */
const SPECIAL_RANK: Record<string, number> = { dev: 1, alpha: 2, a: 2, beta: 3, b: 3, rc: 4, pl: 6, p: 6 };
const NUMBER_RANK = 5;

type Segment = { rank: number; value: number };

/** "6.5-beta1" → ["6", "5", "beta", "1"] (separators -, _, +, and digit/letter transitions). */
function segments(version: string): Segment[] {
  const canonical = version
    .trim()
    .toLowerCase()
    .replace(/[-_+]/g, '.')
    .replace(/(\d)([a-z])/g, '$1.$2')
    .replace(/([a-z])(\d)/g, '$1.$2');
  return canonical
    .split('.')
    .filter((s) => s !== '')
    .map((s) => (/^\d+$/.test(s) ? { rank: NUMBER_RANK, value: Number(s) } : { rank: SPECIAL_RANK[s] ?? 0, value: 0 }));
}

const ZERO: Segment = { rank: NUMBER_RANK, value: 0 };

/** -1 when a < b, 0 when equal, 1 when a > b. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = segments(a);
  const right = segments(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = left[i] ?? ZERO;
    const r = right[i] ?? ZERO;
    if (l.rank !== r.rank) return l.rank < r.rank ? -1 : 1;
    if (l.value !== r.value) return l.value < r.value ? -1 : 1;
  }
  return 0;
}

/** One affected range as in the Wordfence feed; `*` (the whole string) means unbounded. */
export interface VersionRange {
  from_version: string;
  from_inclusive: boolean;
  to_version: string;
  to_inclusive: boolean;
}

export function inRange(version: string, range: VersionRange): boolean {
  if (range.from_version !== '*') {
    const c = compareVersions(version, range.from_version);
    if (c < 0 || (c === 0 && !range.from_inclusive)) return false;
  }
  if (range.to_version !== '*') {
    const c = compareVersions(version, range.to_version);
    if (c > 0 || (c === 0 && !range.to_inclusive)) return false;
  }
  return true;
}
