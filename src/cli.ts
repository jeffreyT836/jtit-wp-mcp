import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadLegacySitesFile } from './config/loader.js';
import { parseEncryptionKey } from './store/crypto.js';
import { resolveSitesDbPath, SiteStore } from './store/site-store.js';

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Reads an application password without echoing it and without it touching argv. */
  readPassword: (prompt: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
}

const USAGE = `Usage: node dist/cli.js sites <command>

  sites list
  sites add --id <id> --name <name> --url <https://...> [--username mcp-bot]
            [--tags a,b] [--read-only] [--allow-http] [--no-bridge] [--keep-password]
      Adds or updates a site. The application password is read from the terminal
      (hidden) or from stdin when piped — never pass it as an argument.
  sites remove --id <id>
  sites import --file <sites.json>
      One-off migration from the old sites.json + *_APP_PASSWORD env vars.

Environment: SITES_ENCRYPTION_KEY (required), SITES_DB (optional).`;

function openStore(env: NodeJS.ProcessEnv): SiteStore {
  return new SiteStore(resolveSitesDbPath(env), parseEncryptionKey(env.SITES_ENCRYPTION_KEY));
}

function listSites(store: SiteStore, io: CliIo): void {
  const sites = store.list();
  if (sites.length === 0) {
    io.stdout('No sites configured.');
    return;
  }
  for (const s of sites) {
    const flags = [s.readOnly && 'read-only', s.allowHttp && 'allow-http', !s.bridge && 'no-bridge']
      .filter(Boolean)
      .join(',');
    io.stdout(
      `${s.id}\t${s.url}\tuser=${s.username}\tpassword=${s.hasPassword ? 'set' : 'MISSING'}` +
        `${s.tags.length ? `\ttags=${s.tags.join(',')}` : ''}${flags ? `\t${flags}` : ''}`,
    );
  }
}

async function addSite(store: SiteStore, args: string[], io: CliIo): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      id: { type: 'string' },
      name: { type: 'string' },
      url: { type: 'string' },
      username: { type: 'string', default: 'mcp-bot' },
      tags: { type: 'string', default: '' },
      'read-only': { type: 'boolean', default: false },
      'allow-http': { type: 'boolean', default: false },
      'no-bridge': { type: 'boolean', default: false },
      'keep-password': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.id || !values.url) {
    throw new Error('--id and --url are required');
  }
  const password = values['keep-password']
    ? undefined
    : await io.readPassword(`Application password for ${values.id}: `);
  const stored = store.upsert(
    {
      id: values.id,
      name: values.name ?? values.id,
      url: values.url,
      username: values.username,
      tags: values.tags.split(',').map((t) => t.trim()).filter(Boolean),
      readOnly: values['read-only'],
      allowHttp: values['allow-http'],
      bridge: !values['no-bridge'],
    },
    password,
  );
  io.stdout(`Saved site "${stored.id}" (password ${stored.hasPassword ? 'set' : 'MISSING'}).`);
}

function removeSite(store: SiteStore, args: string[], io: CliIo): void {
  const { values } = parseArgs({ args, options: { id: { type: 'string' } }, strict: true });
  if (!values.id) throw new Error('--id is required');
  if (!store.remove(values.id)) throw new Error(`unknown site "${values.id}"`);
  io.stdout(`Removed site "${values.id}".`);
}

function importSites(store: SiteStore, args: string[], io: CliIo): void {
  const { values } = parseArgs({ args, options: { file: { type: 'string' } }, strict: true });
  if (!values.file) throw new Error('--file is required');
  for (const { site, password, unavailableReason } of loadLegacySitesFile(values.file, io.env)) {
    store.upsert(site, password ?? undefined);
    io.stdout(
      `Imported "${site.id}"${password === null ? ` without password (${unavailableReason})` : ''}.`,
    );
  }
}

/** Runs the CLI; returns the process exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group !== 'sites' || !command || command === 'help' || command === '--help') {
    io.stdout(USAGE);
    return group === 'sites' || group === undefined ? 0 : 1;
  }
  let store: SiteStore | undefined;
  try {
    store = openStore(io.env);
    switch (command) {
      case 'list':
        listSites(store, io);
        break;
      case 'add':
        await addSite(store, rest, io);
        break;
      case 'remove':
        removeSite(store, rest, io);
        break;
      case 'import':
        importSites(store, rest, io);
        break;
      default:
        io.stderr(`Unknown command "${command}".\n\n${USAGE}`);
        return 1;
    }
    return 0;
  } catch (err) {
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    store?.close();
  }
}

/** Hidden terminal prompt, or the whole of stdin when it is piped. */
async function readPasswordFromProcess(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (data: Buffer): void => {
      for (const char of data.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value.trim());
          return;
        }
        if (char === '\u0003') {
          cleanup();
          reject(new Error('aborted'));
          return;
        }
        value = char === '\u007f' ? value.slice(0, -1) : value + char;
      }
    };
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const code = await runCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    readPassword: readPasswordFromProcess,
    env: process.env,
  });
  process.exit(code);
}
