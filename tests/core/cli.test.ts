import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.js';
import { SiteStore } from '../../src/store/site-store.js';

const key = randomBytes(32);

function setup(password = 'abcd 1234') {
  const dir = mkdtempSync(join(tmpdir(), 'wp-fleet-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const env = { SITES_DB: join(dir, 'sites.db'), SITES_ENCRYPTION_KEY: key.toString('base64') };
  const io: CliIo = {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    readPassword: async (prompt) => {
      prompts.push(prompt);
      return password;
    },
    env,
  };
  const withStore = <T>(fn: (store: SiteStore) => T): T => {
    const store = new SiteStore(env.SITES_DB, key);
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };
  return { dir, out, err, prompts, io, env, withStore };
}

const addArgs = ['sites', 'add', '--id', 'klant-a', '--url', 'https://klant-a.nl'];

describe('runCli', () => {
  it('prints usage for no/unknown args', async () => {
    const { io, out, err } = setup();
    expect(await runCli([], io)).toBe(0);
    expect(out.join()).toContain('Usage');
    expect(await runCli(['nope'], io)).toBe(1);
    expect(await runCli(['sites', 'frobnicate'], io)).toBe(1);
    expect(err.join()).toContain('Unknown command');
  });

  it('adds a site, prompting for the password, then lists it without the secret', async () => {
    const { io, out, prompts, withStore } = setup('secret pw');
    expect(
      await runCli([...addArgs, '--name', 'Klant A', '--tags', 'prod, woo', '--read-only'], io),
    ).toBe(0);
    expect(prompts).toEqual(['Application password for klant-a: ']);
    expect(withStore((s) => s.load()[0])).toMatchObject({
      name: 'Klant A',
      username: 'mcp-bot',
      tags: ['prod', 'woo'],
      readOnly: true,
      password: 'secret pw',
    });
    out.length = 0;
    expect(await runCli(['sites', 'list'], io)).toBe(0);
    expect(out[0]).toContain('klant-a');
    expect(out[0]).toContain('password=set');
    expect(out.join()).not.toContain('secret pw');
  });

  it('--keep-password updates metadata without prompting', async () => {
    const { io, prompts, withStore } = setup('pw');
    await runCli(addArgs, io);
    expect(await runCli([...addArgs, '--no-bridge', '--keep-password'], io)).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(withStore((s) => s.load()[0])).toMatchObject({ bridge: false, password: 'pw' });
  });

  it('reports errors with exit code 1', async () => {
    const { io, err } = setup();
    expect(await runCli(['sites', 'add', '--id', 'x'], io)).toBe(1);
    expect(await runCli(['sites', 'remove', '--id', 'missing'], io)).toBe(1);
    expect(await runCli(['sites', 'list'], { ...io, env: {} })).toBe(1);
    expect(err.join('\n')).toMatch(/--url are required[\s\S]*unknown site[\s\S]*SITES_ENCRYPTION_KEY/);
  });

  it('removes a site', async () => {
    const { io, out, withStore } = setup();
    await runCli(addArgs, io);
    expect(await runCli(['sites', 'remove', '--id', 'klant-a'], io)).toBe(0);
    expect(withStore((s) => s.list())).toEqual([]);
    expect(await runCli(['sites', 'list'], io)).toBe(0);
    expect(out.at(-1)).toBe('No sites configured.');
  });

  it('imports a legacy sites.json with env passwords', async () => {
    const { io, dir, out, withStore } = setup();
    const file = join(dir, 'sites.json');
    writeFileSync(
      file,
      JSON.stringify({
        sites: [
          { id: 'a-site', name: 'A', url: 'https://a.nl', username: 'bot', passwordEnv: 'WP_A' },
          { id: 'b-site', name: 'B', url: 'https://b.nl', username: 'bot', passwordEnv: 'WP_B' },
        ],
      }),
    );
    expect(await runCli(['sites', 'import', '--file', file], { ...io, env: { ...io.env, WP_A: 'pw-a' } })).toBe(0);
    expect(out.join('\n')).toMatch(/"b-site" without password/);
    expect(withStore((s) => s.load().map((x) => [x.id, x.password]))).toEqual([
      ['a-site', 'pw-a'],
      ['b-site', null],
    ]);
  });
});
