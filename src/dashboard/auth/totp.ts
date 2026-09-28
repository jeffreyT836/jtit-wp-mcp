import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { renderSVG } from 'uqr';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'JTIT WP Dashboard';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit TOTP secret, base32-encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 6238 / 4226 HOTP value for a given counter (SHA-1, 6 digits). */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

export function totpAt(secretB32: string, timeMs: number): string {
  return hotp(base32Decode(secretB32), Math.floor(timeMs / 1000 / PERIOD_SECONDS));
}

/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(secretB32: string, code: string, nowMs = Date.now()): boolean {
  const cleaned = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor(nowMs / 1000 / PERIOD_SECONDS);
  let ok = false;
  for (const delta of [-1, 0, 1]) {
    const expected = Buffer.from(hotp(secret, counter + delta));
    if (timingSafeEqual(expected, Buffer.from(cleaned))) ok = true;
  }
  return ok;
}

export function otpauthUri(secretB32: string, account: string): string {
  const label = encodeURIComponent(`${ISSUER}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer: ISSUER, digits: String(DIGITS), period: String(PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Inline SVG QR code for an otpauth URI (rendered server-side; no external requests). */
export function qrSvg(uri: string): string {
  return renderSVG(uri, { border: 2 });
}

/**
 * Key for encrypting TOTP secrets at rest, derived from `SITES_ENCRYPTION_KEY` with HKDF so
 * the same master key is never used directly for two purposes.
 */
export function deriveTotpKey(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'wp-dashboard/totp-secret/v1', 32));
}
