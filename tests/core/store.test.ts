import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
  SecretCryptoError,
} from '../../src/store/crypto.js';
import { resolveSitesDbPath, SiteStore, SiteStoreError } from '../../src/store/site-store.js';
import { SiteRegistry } from '../../src/wp/registry.js';

const key = randomBytes(32);
const site = {
  id: 'klant-a',
  name: 'Klant A',
  url: 'https://www.klant-a.nl',
  username: 'mcp-bot',
};

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'wp-fleet-store-')), 'nested', 'sites.db');
}

describe('crypto', () => {
  it('parses a base64 32-byte key', () => {
    expect(parseEncryptionKey(key.toString('base64')).equals(key)).toBe(true);
  });

  it.each([
    [undefined, /not set/],
    ['', /not set/],
    ['not base64!!', /base64/],
    [randomBytes(16).toString('base64'), /32 bytes/],
  ])('rejects key %j', (raw, message) => {
    expect(() => parseEncryptionKey(raw)).toThrow(message);
  });

  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret('abcd 1234', key, 'site-a');
    const b = encryptSecret('abcd 1234', key, 'site-a');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(decryptSecret(a, key, 'site-a')).toBe('abcd 1234');
  });

  it('fails on wrong AAD, wrong key, tampering and bad format', () => {
    const payload = encryptSecret('secret', key, 'site-a');
    expect(() => decryptSecret(payload, key, 'site-b')).toThrow(SecretCryptoError);
    expect(() => decryptSecret(payload, randomBytes(32), 'site-a')).toThrow(SecretCryptoError);
    const parts = payload.split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join('.'), key, 'site-a')).toThrow(SecretCryptoError);
    expect(() => decryptSecret('v0.a.b.c', key, 'site-a')).toThrow(/format/);
  });
});

describe('resolveSitesDbPath', () => {
  it('prefers SITES_DB', () => {
    expect(resolveSitesDbPath({ SITES_DB: '/x/y.db' })).toBe('/x/y.db');
  });

  it('falls back to ./data/sites.db outside the container', () => {
    expect(resolveSitesDbPath({})).toBe('./data/sites.db');
  });
});

describe('SiteStore', () => {
  const stores: SiteStore[] = [];
  const open = (path = ':memory:', k = key): SiteStore => {
    const store = new SiteStore(path, k);
    stores.push(store);
    return store;
  };
  afterEach(() => {
    for (const store of stores.splice(0)) {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
  });

  it('starts empty at version 0', () => {
    const store = open();
    expect(store.list()).toEqual([]);
    expect(store.version()).toBe(0);
  });

  it('stores a site with defaults and an encrypted password', () => {
    const path = tempDbPath();
    const store = open(path);
    const stored = store.upsert(site, 'abcd efgh ijkl');
    expect(stored).toMatchObject({
      ...site,
      tags: [],
      readOnly: false,
      allowHttp: false,
      bridge: true,
      hasPassword: true,
    });
    expect(store.load()[0]).toMatchObject({ password: 'abcd efgh ijkl', available: true });
    store.close();
    expect(readFileSync(path).includes(Buffer.from('abcd efgh ijkl'))).toBe(false);
  });

  it('bumps the version on every mutation', () => {
    const store = open();
    store.upsert(site, 'pw');
    store.upsert({ ...site, name: 'Renamed' });
    store.remove(site.id);
    expect(store.version()).toBe(3);
  });

  it('keeps the password when undefined, clears it when null', () => {
    const store = open();
    store.upsert(site, 'pw');
    store.upsert({ ...site, tags: ['prod'], readOnly: true });
    expect(store.load()[0]).toMatchObject({ password: 'pw', tags: ['prod'], readOnly: true });
    store.upsert(site, null);
    expect(store.load()[0]).toMatchObject({
      password: null,
      available: false,
      unavailableReason: 'no application password stored',
    });
  });

  it('rejects invalid sites and empty passwords without bumping the version', () => {
    const store = open();
    expect(() => store.upsert({ ...site, id: 'Bad Id' }, 'pw')).toThrow(SiteStoreError);
    expect(() => store.upsert(site, '   ')).toThrow(/empty/);
    expect(store.version()).toBe(0);
  });

  it('removes sites and reports unknown ids', () => {
    const store = open();
    store.upsert(site, 'pw');
    expect(store.remove('klant-a')).toBe(true);
    expect(store.remove('klant-a')).toBe(false);
    expect(store.remove('Not Valid')).toBe(false);
  });

  it('marks a site unavailable when the key does not match', () => {
    const path = tempDbPath();
    open(path).upsert(site, 'pw');
    const loaded = open(path, randomBytes(32)).load();
    expect(loaded[0]).toMatchObject({ available: false, password: null });
    expect(loaded[0]?.unavailableReason).toMatch(/SITES_ENCRYPTION_KEY/);
  });

  it('lets a registry in another connection pick up changes without restart', () => {
    const path = tempDbPath();
    const writer = open(path);
    const registry = new SiteRegistry(open(path));
    expect(registry.list()).toEqual([]);
    writer.upsert(site, 'pw');
    expect(registry.get('klant-a').password).toBe('pw');
    const client = registry.client('klant-a');
    expect(registry.client('klant-a')).toBe(client);
    writer.upsert({ ...site, url: 'https://new.klant-a.nl' });
    expect(registry.client('klant-a')).not.toBe(client);
    expect(registry.get('klant-a').url).toBe('https://new.klant-a.nl');
    writer.remove('klant-a');
    expect(() => registry.get('klant-a')).toThrow(/unknown site/);
  });
});
