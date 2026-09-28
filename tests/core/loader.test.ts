import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadLegacySitesFile, resolveSecret, resolveSite } from '../../src/config/loader.js';

function writeSitesJson(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-fleet-mcp-test-'));
  const path = join(dir, 'sites.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

const baseSite = {
  id: 'klant-a',
  name: 'Klant A',
  url: 'https://www.klant-a.nl',
  username: 'mcp-bot',
  passwordEnv: 'WP_KLANT_A_APP_PASSWORD',
};

describe('resolveSecret', () => {
  it('reads directly from env', () => {
    const result = resolveSecret('WP_FOO', { WP_FOO: '  secret-value  ' });
    expect(result).toEqual({ password: 'secret-value', reason: null });
  });

  it('falls back to the _FILE variant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-fleet-mcp-secret-'));
    const secretPath = join(dir, 'secret.txt');
    writeFileSync(secretPath, 'file-secret\n');
    const result = resolveSecret('WP_FOO', { WP_FOO_FILE: secretPath });
    expect(result).toEqual({ password: 'file-secret', reason: null });
  });

  it('reports a reason when neither is set', () => {
    const result = resolveSecret('WP_FOO', {});
    expect(result.password).toBeNull();
    expect(result.reason).toContain('WP_FOO');
  });

  it('reports a reason when the _FILE path cannot be read', () => {
    const result = resolveSecret('WP_FOO', { WP_FOO_FILE: '/does/not/exist' });
    expect(result.password).toBeNull();
    expect(result.reason).toContain('WP_FOO_FILE');
  });
});

describe('resolveSite', () => {
  const site = {
    id: 'klant-a',
    name: 'Klant A',
    url: 'https://www.klant-a.nl',
    username: 'mcp-bot',
    tags: [],
    readOnly: false,
    allowHttp: false,
    bridge: true,
    healthPaths: [],
  };

  it('is available with a password and https url', () => {
    expect(resolveSite(site, 'pw')).toMatchObject({ available: true, unavailableReason: null });
  });

  it('is unavailable without a password', () => {
    expect(resolveSite(site, null)).toMatchObject({
      available: false,
      unavailableReason: 'no application password stored',
    });
  });

  it('is unavailable for http:// unless allowHttp is set', () => {
    expect(resolveSite({ ...site, url: 'http://x.test' }, 'pw').unavailableReason).toMatch(/https/);
    expect(resolveSite({ ...site, url: 'http://x.test', allowHttp: true }, 'pw').available).toBe(true);
  });
});

describe('loadLegacySitesFile', () => {
  it('parses a valid file, strips passwordEnv and resolves secrets from env', () => {
    const path = writeSitesJson({ sites: [baseSite] });
    const [entry] = loadLegacySitesFile(path, { WP_KLANT_A_APP_PASSWORD: 'abcd 1234 efgh' });
    expect(entry?.password).toBe('abcd 1234 efgh');
    expect(entry?.unavailableReason).toBeNull();
    expect(entry?.site).toEqual({
      id: 'klant-a',
      name: 'Klant A',
      url: 'https://www.klant-a.nl',
      username: 'mcp-bot',
      tags: [],
      readOnly: false,
      allowHttp: false,
      bridge: true,
      healthPaths: [],
    });
  });

  it('resolves secrets from the _FILE fallback (Docker secrets)', () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'wp-fleet-mcp-secret-'));
    const secretPath = join(secretDir, 'pw.txt');
    writeFileSync(secretPath, 'file-based-secret');
    const path = writeSitesJson({ sites: [baseSite] });
    const [entry] = loadLegacySitesFile(path, { WP_KLANT_A_APP_PASSWORD_FILE: secretPath });
    expect(entry?.password).toBe('file-based-secret');
  });

  it('reports why a secret could not be resolved', () => {
    const path = writeSitesJson({ sites: [baseSite] });
    const [entry] = loadLegacySitesFile(path, {});
    expect(entry?.password).toBeNull();
    expect(entry?.unavailableReason).toContain('WP_KLANT_A_APP_PASSWORD');
  });

  it('throws ConfigError for invalid JSON', () => {
    const path = writeSitesJson('{not json');
    expect(() => loadLegacySitesFile(path, {})).toThrow(ConfigError);
  });

  it('throws ConfigError when the file does not exist', () => {
    expect(() => loadLegacySitesFile('/does/not/exist.json', {})).toThrow(ConfigError);
  });

  it('throws ConfigError for schema validation errors', () => {
    const path = writeSitesJson({ sites: [{ ...baseSite, id: 'Invalid ID!' }] });
    expect(() => loadLegacySitesFile(path, {})).toThrow(ConfigError);
  });

  it('throws ConfigError for duplicate site ids', () => {
    const path = writeSitesJson({ sites: [baseSite, { ...baseSite }] });
    expect(() => loadLegacySitesFile(path, {})).toThrow(/duplicate/);
  });
});
