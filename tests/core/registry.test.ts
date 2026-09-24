import { describe, expect, it } from 'vitest';
import { SiteNotFoundError } from '../../src/wp/registry.js';
import { SiteRegistry } from '../../src/wp/registry.js';
import { makeSite } from '../helpers/harness.js';

describe('SiteRegistry.client', () => {
  it('throws for an unknown site id', () => {
    const registry = new SiteRegistry([makeSite({ id: 'a' })]);
    expect(() => registry.client('nope')).toThrow(SiteNotFoundError);
  });

  it('refuses to build a client for an unavailable site (defense-in-depth alongside WpClient)', () => {
    const registry = new SiteRegistry([
      makeSite({ id: 'a', available: false, unavailableReason: 'missing secret', password: null }),
    ]);
    expect(() => registry.client('a')).toThrow(/missing secret/);
  });

  it('refuses to build a client for a non-https site without allowHttp, even if marked available', () => {
    const registry = new SiteRegistry([
      makeSite({ id: 'a', url: 'http://a.example.com', allowHttp: false, available: true }),
    ]);
    expect(() => registry.client('a')).toThrow(/https/);
  });

  it('builds and caches a client for an available, https (or allowHttp) site', () => {
    const registry = new SiteRegistry([makeSite({ id: 'a' })]);
    const client1 = registry.client('a');
    const client2 = registry.client('a');
    expect(client1).toBe(client2);
  });
});
