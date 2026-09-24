import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolveSecret, resolveSitesConfigPath } from '../../src/config/loader.js';

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

describe('resolveSitesConfigPath', () => {
  it('uses SITES_CONFIG when set', () => {
    expect(resolveSitesConfigPath({ SITES_CONFIG: '/custom/path.json' })).toBe('/custom/path.json');
  });

  it('falls back to ./config/sites.json when nothing else applies', () => {
    expect(resolveSitesConfigPath({})).toBe('./config/sites.json');
  });
});

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

describe('loadConfig', () => {
  it('loads a valid config and resolves secrets from env', () => {
    const path = writeSitesJson({ sites: [baseSite] });
    const config = loadConfig(path, { WP_KLANT_A_APP_PASSWORD: 'abcd 1234 efgh' });
    expect(config.sites).toHaveLength(1);
    expect(config.sites[0]).toMatchObject({
      id: 'klant-a',
      password: 'abcd 1234 efgh',
      available: true,
      unavailableReason: null,
      tags: [],
      readOnly: false,
      allowHttp: false,
      bridge: true,
    });
  });

  it('resolves secrets from the _FILE fallback (Docker secrets)', () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'wp-fleet-mcp-secret-'));
    const secretPath = join(secretDir, 'pw.txt');
    writeFileSync(secretPath, 'file-based-secret');
    const path = writeSitesJson({ sites: [baseSite] });
    const config = loadConfig(path, { WP_KLANT_A_APP_PASSWORD_FILE: secretPath });
    expect(config.sites[0]?.password).toBe('file-based-secret');
    expect(config.sites[0]?.available).toBe(true);
  });

  it('marks a site unavailable when its secret cannot be resolved', () => {
    const path = writeSitesJson({ sites: [baseSite] });
    const config = loadConfig(path, {});
    expect(config.sites[0]?.available).toBe(false);
    expect(config.sites[0]?.unavailableReason).toContain('WP_KLANT_A_APP_PASSWORD');
    expect(config.sites[0]?.password).toBeNull();
  });

  it('marks an http:// site unavailable unless allowHttp is set', () => {
    const path = writeSitesJson({ sites: [{ ...baseSite, url: 'http://localhost:8080' }] });
    const config = loadConfig(path, { WP_KLANT_A_APP_PASSWORD: 'secret' });
    expect(config.sites[0]?.available).toBe(false);
    expect(config.sites[0]?.unavailableReason).toMatch(/https/);
  });

  it('allows http:// when allowHttp is true', () => {
    const path = writeSitesJson({
      sites: [{ ...baseSite, url: 'http://localhost:8080', allowHttp: true }],
    });
    const config = loadConfig(path, { WP_KLANT_A_APP_PASSWORD: 'secret' });
    expect(config.sites[0]?.available).toBe(true);
  });

  it('throws ConfigError for invalid JSON', () => {
    const path = writeSitesJson('{not json');
    expect(() => loadConfig(path, {})).toThrow(ConfigError);
  });

  it('throws ConfigError when the file does not exist', () => {
    expect(() => loadConfig('/does/not/exist.json', {})).toThrow(ConfigError);
  });

  it('throws ConfigError for schema validation errors', () => {
    const path = writeSitesJson({ sites: [{ ...baseSite, id: 'Invalid ID!' }] });
    expect(() => loadConfig(path, {})).toThrow(ConfigError);
  });

  it('throws ConfigError for duplicate site ids', () => {
    const path = writeSitesJson({ sites: [baseSite, { ...baseSite }] });
    expect(() => loadConfig(path, {})).toThrow(/duplicate/);
  });
});
