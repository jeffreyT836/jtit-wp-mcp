/**
 * Streaming splitter for a JSON document whose root is an object of records
 * (`{ "<uuid>": { ... }, "<uuid>": { ... } }`), like the Wordfence Intelligence feed.
 *
 * The production feed is far too large to `JSON.parse` in one go, so this walks the bytes
 * once, tracking brace depth (string- and escape-aware), and yields the JSON text of each
 * top-level object/array value. The caller parses each record on its own. Chunk boundaries
 * may fall anywhere: inside a string, an escape sequence or a multibyte UTF-8 character.
 * Primitive top-level values (not expected in the feed) are skipped.
 */

const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \
const OPEN_OBJ = 0x7b; // {
const CLOSE_OBJ = 0x7d; // }
const OPEN_ARR = 0x5b; // [
const CLOSE_ARR = 0x5d; // ]
const COLON = 0x3a; // :

const isWhitespace = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

export class FeedFormatError extends Error {}

export async function* splitTopLevelRecords(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let rootSeen = false;
  let rootClosed = false;
  /** At depth 1 after a ':' and before the value started. */
  let expectingValue = false;
  let capturing = false;
  let parts: string[] = [];

  function* scan(text: string): Generator<string> {
    let segStart = capturing ? 0 : -1;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === BACKSLASH) escaped = true;
        else if (c === QUOTE) inString = false;
        continue;
      }
      if (rootClosed) {
        if (!isWhitespace(c)) throw new FeedFormatError('onverwachte data na het einde van de feed');
        continue;
      }
      if (!rootSeen) {
        if (isWhitespace(c)) continue;
        if (c !== OPEN_OBJ) throw new FeedFormatError('de feed is geen JSON-object');
        rootSeen = true;
        depth = 1;
        continue;
      }
      if (c === QUOTE) {
        inString = true;
        if (depth === 1 && expectingValue) expectingValue = false; // primitive string value: skipped
        continue;
      }
      if (c === OPEN_OBJ || c === OPEN_ARR) {
        if (depth === 1 && expectingValue) {
          expectingValue = false;
          capturing = true;
          segStart = i;
        }
        depth += 1;
        continue;
      }
      if (c === CLOSE_OBJ || c === CLOSE_ARR) {
        depth -= 1;
        if (capturing && depth === 1) {
          parts.push(text.slice(segStart, i + 1));
          yield parts.join('');
          parts = [];
          capturing = false;
          segStart = -1;
        } else if (depth === 0) {
          rootClosed = true;
        } else if (depth < 0) {
          throw new FeedFormatError('ongebalanceerde haakjes in de feed');
        }
        continue;
      }
      if (depth === 1 && !capturing) {
        if (c === COLON) expectingValue = true;
        else if (expectingValue && !isWhitespace(c)) expectingValue = false; // number/true/false/null
      }
    }
    if (capturing && segStart >= 0) parts.push(text.slice(segStart));
  }

  for await (const chunk of source) {
    yield* scan(decoder.decode(chunk, { stream: true }));
  }
  yield* scan(decoder.decode());
  if (!rootSeen) throw new FeedFormatError('de feed is leeg');
  if (!rootClosed || inString) throw new FeedFormatError('de feed is afgebroken (onvolledig JSON-document)');
}
