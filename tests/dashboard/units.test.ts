import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/dashboard/auth/password.js';
import { RateLimiter } from '../../src/dashboard/auth/rate-limit.js';
import {
  base32Decode,
  base32Encode,
  deriveTotpKey,
  generateTotpSecret,
  hotp,
  otpauthUri,
  qrSvg,
  totpAt,
  verifyTotp,
} from '../../src/dashboard/auth/totp.js';
import { DashboardDb } from '../../src/dashboard/db.js';
import { storeIngest, summarizeSite } from '../../src/dashboard/snapshots.js';
import { escapeHtml, html, trusted } from '../../src/dashboard/views/html.js';

describe('totp', () => {
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches RFC 6238 SHA-1 vector at T=%i', (seconds, code) => {
    expect(totpAt(rfcSecret, seconds * 1000)).toBe(code);
  });

  it('round-trips base32 and rejects invalid input', () => {
    const bytes = randomBytes(20);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(() => base32Decode('!!!')).toThrow(/base32/);
  });

  it('verifies with ±1 step drift, rejects others and malformed codes', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now + 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now + 90_000), now)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
    expect(verifyTotp(secret, '12345', now)).toBe(false);
  });

  it('builds an otpauth uri, an svg QR and a separate derived key', () => {
    expect(otpauthUri('ABC', 'me@x.nl')).toMatch(/^otpauth:\/\/totp\/JTIT%20WP%20Dashboard%3Ame%40x\.nl\?secret=ABC/);
    expect(qrSvg('otpauth://x')).toMatch(/^<svg/);
    const master = randomBytes(32);
    expect(deriveTotpKey(master)).toHaveLength(32);
    expect(deriveTotpKey(master).equals(master)).toBe(false);
    expect(hotp(Buffer.from('12345678901234567890'), 0)).toBe('755224');
  });
});

describe('password', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('enforces a minimum length', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least/);
  });
});

describe('RateLimiter', () => {
  it('limits within a window and resets after it', () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.take('ip', 0)).toBe(true);
    expect(limiter.take('ip', 1)).toBe(true);
    expect(limiter.take('ip', 2)).toBe(false);
    expect(limiter.take('other', 2)).toBe(true);
    expect(limiter.take('ip', 1001)).toBe(true);
  });
});

describe('html', () => {
  it('escapes interpolations but not nested html or trusted markup', () => {
    const name = '<script>alert("x")</script>';
    const out = html`<p title="${name}">${name}${html`<b>${'&'}</b>`}${trusted('<i>t</i>')}${null}${[1, '<']}</p>`;
    expect(out.value).toBe(
      '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<b>&amp;</b><i>t</i>1&lt;</p>',
    );
    expect(escapeHtml("'`")).toBe('&#39;&#96;');
  });
});

describe('snapshots', () => {
  const fleetHealth = {
    summary: { sites: 2 },
    results: [
      { site: 'a-site', ok: true, data: { ok: true, roles: ['administrator'], bridge: 'ok', versions: { wp_version: '6.8', php_version: '8.3' } } },
      { site: 'unknown', ok: true, data: { ok: true } },
    ],
  };

  it('splits fleet payloads per known site and keeps the fleet snapshot', () => {
    const db = new DashboardDb(':memory:');
    const written = storeIngest(db, { kind: 'fleet_health', data: fleetHealth }, new Set(['a-site']));
    expect(written).toBe(2);
    expect(db.latestSnapshots('a-site')).toHaveLength(1);
    expect(db.latestSnapshots(null)).toHaveLength(1);
    expect(db.lastSnapshotReceivedAt()).toBeTruthy();
    expect(storeIngest(db, { kind: 'site_info', site: 'a-site', data: { x: 1 } }, new Set())).toBe(1);
    db.pruneSnapshots(new Date(Date.now() + 1000).toISOString());
    expect(db.latestSnapshots()).toEqual([]);
    db.close();
  });

  it('summarizes health and updates', () => {
    const db = new DashboardDb(':memory:');
    const ids = new Set(['a-site']);
    storeIngest(db, { kind: 'fleet_health', data: fleetHealth }, ids);
    storeIngest(db, {
      kind: 'fleet_updates_report',
      data: { results: [{ site: 'a-site', ok: true, data: { core: [{ response: 'upgrade' }, { response: 'latest' }], plugins: [1, 2], themes: [] } }] },
    }, ids);
    expect(summarizeSite(db.latestSnapshots('a-site'))).toMatchObject({
      reachable: true,
      isAdmin: true,
      bridge: 'ok',
      wpVersion: '6.8',
      phpVersion: '8.3',
      updates: { core: 1, plugins: 2, themes: 0 },
    });
    const failed = summarizeSite([
      { id: 1, site_id: 'a', kind: 'fleet_updates_report', data: JSON.stringify({ ok: false, error: 'bridge missing' }), collected_at: 'x', received_at: 'x' },
      { id: 2, site_id: 'a', kind: 'fleet_health', data: 'not json', collected_at: 'x', received_at: 'x' },
    ]);
    expect(failed.updatesError).toBe('bridge missing');
    db.close();
  });
});
