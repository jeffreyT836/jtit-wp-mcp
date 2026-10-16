import { describe, expect, it } from 'vitest';
import { FeedFormatError, splitTopLevelRecords } from '../../src/vuln/feed-parser.js';
import { chunks, FEED, iterate } from './fixtures.js';

async function collect(text: string, size: number): Promise<string[]> {
  const out: string[] = [];
  for await (const record of splitTopLevelRecords(iterate(chunks(text, size)))) out.push(record);
  return out;
}

describe('splitTopLevelRecords', () => {
  const text = JSON.stringify(FEED, null, 2);
  const expected = Object.values(FEED);

  it('yields every top-level record as parseable JSON', async () => {
    const records = await collect(text, 64 * 1024);
    expect(records.map((r) => JSON.parse(r))).toEqual(expected);
  });

  it.each([1, 2, 3, 5, 13, 1000])('handles chunk boundaries anywhere (chunk size %i)', async (size) => {
    const records = await collect(text, size);
    expect(records.map((r) => JSON.parse(r))).toEqual(expected);
  });

  it('keeps braces, quotes and escapes inside strings intact', async () => {
    const tricky = { a: { s: 'brace } and { and "quote" and \\ backslash \\" end', n: [1, { x: '}' }] }, b: { t: '\\\\' } };
    for (const size of [1, 2, 4]) {
      const records = await collect(JSON.stringify(tricky), size);
      expect(records.map((r) => JSON.parse(r))).toEqual([tricky.a, tricky.b]);
    }
  });

  it('decodes multibyte UTF-8 split over chunks', async () => {
    const doc = { k: { title: 'Ünïcödé ✓ 🚀 日本語' } };
    const records = await collect(JSON.stringify(doc), 1);
    expect(JSON.parse(records[0]!)).toEqual(doc.k);
  });

  it('skips primitive top-level values and accepts arrays', async () => {
    const records = await collect('{"a": 1, "b": "x}", "c": [1, {"d": 2}], "e": null, "f": {"g": true}}', 3);
    expect(records.map((r) => JSON.parse(r))).toEqual([[1, { d: 2 }], { g: true }]);
  });

  it.each([1, 7, 64 * 1024])('skips oversized records and reports them (chunk size %i)', async (size) => {
    const small1 = { id: 'a', s: 'x}' };
    const small2 = { id: 'c', s: '{"y"' };
    const big = { id: 'b', pad: 'p'.repeat(500), nested: { s: 'braces } { and "quotes" \\ inside' } };
    const doc = JSON.stringify({ a: small1, b: big, c: small2 });
    let skipped = 0;
    const out: string[] = [];
    const source = iterate(chunks(doc, size));
    for await (const r of splitTopLevelRecords(source, { maxRecordChars: 200, onSkipped: () => (skipped += 1) })) out.push(r);
    expect(out.map((r) => JSON.parse(r))).toEqual([small1, small2]);
    expect(skipped).toBe(1);
  });

  it('keeps records exactly at the limit', async () => {
    const record = JSON.stringify({ id: 'a' });
    const out: string[] = [];
    for await (const r of splitTopLevelRecords(iterate(chunks(`{"a":${record}}`, 3)), { maxRecordChars: record.length })) out.push(r);
    expect(out).toEqual([record]);
  });

  it('accepts an empty feed object', async () => {
    expect(await collect(' {}\n', 1)).toEqual([]);
  });

  it('rejects non-object roots, truncated documents and trailing data', async () => {
    await expect(collect('[1,2]', 4)).rejects.toBeInstanceOf(FeedFormatError);
    await expect(collect('', 4)).rejects.toThrow('leeg');
    await expect(collect('{"a": {"b": 1}', 4)).rejects.toThrow('afgebroken');
    await expect(collect('{"a": {"b": "unterminated', 4)).rejects.toThrow('afgebroken');
    await expect(collect('{} x', 4)).rejects.toThrow('na het einde');
  });
});
