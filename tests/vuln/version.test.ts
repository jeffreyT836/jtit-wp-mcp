import { describe, expect, it } from 'vitest';
import { compareVersions, inRange } from '../../src/vuln/version.js';

describe('compareVersions', () => {
  it.each([
    ['1.0', '1.0.0', 0],
    ['6.8', '6.8.3', -1],
    ['6.8.10', '6.8.9', 1],
    ['5.8.1', '5.8.1', 0],
    ['10.0', '9.9.9', 1],
    ['6.5-beta1', '6.5', -1],
    ['6.5-RC1', '6.5-beta2', 1],
    ['6.5-alpha', '6.5-beta', -1],
    ['6.5-dev', '6.5-alpha', -1],
    ['1.0pl1', '1.0', 1],
    ['1.0-rc1', '1.0-rc2', -1],
    ['2.0.0+build', '2.0.0', -1],
    [' 4.6.0 ', '4.6', 0],
  ] as const)('%s vs %s = %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
    expect(compareVersions(b, a)).toBe(expected === 0 ? 0 : -expected);
  });
});

describe('inRange', () => {
  const r = (from: string, fromInc: boolean, to: string, toInc: boolean) => ({
    from_version: from, from_inclusive: fromInc, to_version: to, to_inclusive: toInc,
  });

  it('treats * as unbounded', () => {
    expect(inRange('0.1', r('*', true, '5.8.1', true))).toBe(true);
    expect(inRange('99', r('1.0', true, '*', true))).toBe(true);
    expect(inRange('1.0', r('*', true, '*', true))).toBe(true);
  });

  it('honours inclusive and exclusive bounds', () => {
    expect(inRange('5.8.1', r('*', true, '5.8.1', true))).toBe(true);
    expect(inRange('5.8.1', r('*', true, '5.8.1', false))).toBe(false);
    expect(inRange('5.8.2', r('*', true, '5.8.1', true))).toBe(false);
    expect(inRange('4.0.0', r('4.0.0', true, '4.6.0', true))).toBe(true);
    expect(inRange('4.0.0', r('4.0.0', false, '4.6.0', true))).toBe(false);
    expect(inRange('3.9', r('4.0.0', true, '4.6.0', true))).toBe(false);
    expect(inRange('4.6', r('4.0.0', true, '4.6.0', true))).toBe(true);
  });

  it('only treats a whole "*" as a wildcard', () => {
    expect(inRange('6.0', r('6.*', true, '6.9', true))).toBe(true);
  });
});
