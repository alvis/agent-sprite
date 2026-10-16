import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Sprite, SpriteFilesystem, SpritesClient } from '@fly/sprites';
import { vi } from 'vitest';

import { catalog } from '#core/catalog';
import { SpriteGuestChannel } from '#drivers/providers/sprite/channel';
import { SpriteProvider } from '#drivers/providers/sprite/provider';
import { toRecord } from '#drivers/providers/sprite/records';
import { SetupConnection } from '#integrations/guest/connection';
import { HOMEBREW_GH } from '#tools/accounts';

import type { ChownOptions, ExecResult } from '@fly/sprites';

import type { ProviderDriver, WorkstationRecord } from '#drivers/contracts';

// the agent services core lets a provider stop and restore, as core binds them
const restorableServices = Object.values(catalog.agents).map(
  ({ service }) => service.name,
);

/** inputs for a Sprite SDK boundary backed by an isolated local filesystem */
export interface FilesystemSpriteParams {
  root: string;
  execute?: Sprite['execFile'];
}

/** one observed SDK native command response in execution order */
export interface NativeCommandResponse {
  argv: string[];
  result: ExecResult;
}

const channels = new WeakMap<Sprite, SpriteGuestChannel>();

/**
 * presents an SDK mock through the Sprite driver's guest channel, reusing one
 * channel per Sprite so every caller acts on the same target
 * @param sprite SDK mock
 * @returns the driver channel bound to the mock
 */
export function guestOf(sprite: Sprite): SpriteGuestChannel {
  const existing = channels.get(sprite);
  if (existing) {
    return existing;
  }
  const channel = new SpriteGuestChannel({ sprite, restorableServices });
  channels.set(sprite, channel);

  return channel;
}

/**
 * answers the Sprite service-registry endpoint from the SDK mock's
 * listServices, so one mock drives both the registry read and the SDK
 * mutations; any other request fails instead of reaching the network
 * @param sprite SDK mock whose listServices supplies the registry
 */
export function serveServiceRegistry(sprite: Sprite): void {
  const registry = `${sprite.client.baseURL}/v1/sprites/${encodeURIComponent(sprite.name)}/services`;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== registry) {
        throw new Error(`Unexpected network request: ${url}`);
      }

      return Response.json(await sprite.listServices());
    }),
  );
}

/**
 * presents an SDK client mock through the Sprite provider driver
 * @param client SDK client mock
 * @returns the driver bound to the mock client
 */
export function providerOf(client: SpritesClient): ProviderDriver {
  return new SpriteProvider({
    client,
    sprites: new WeakMap(),
    channels: new Map(),
    restorableServices,
  });
}

/**
 * binds a provider to one SDK mock and returns the record it would have listed,
 * so provider calls on the record reach the mock without another lookup
 * @param sprite SDK mock
 * @returns the bound provider, the workstation record for the mock and its setup connection
 */
export function workstationOf(sprite: Sprite): {
  provider: ProviderDriver;
  workstation: WorkstationRecord;
  connection: SetupConnection;
} {
  const workstation = toRecord(sprite);
  const provider = new SpriteProvider({
    client: sprite.client,
    sprites: new WeakMap([[workstation, sprite]]),
    channels: new Map([[workstation.id, guestOf(sprite)]]),
    restorableServices,
  });

  return {
    provider,
    workstation,
    connection: new SetupConnection(provider, workstation),
  };
}

/**
 * creates an SDK filesystem boundary that performs real temporary-file operations
 * @param params temporary root and optional native command response boundary
 * @returns Sprite whose filesystem paths are rooted in the temporary directory
 */
export function createFilesystemSprite(params: FilesystemSpriteParams): Sprite {
  const { root, execute = executeNativeConfiguration } = params;
  function readRootFile(path: string, encoding?: 'utf8'): Promise<string>;
  function readRootFile(path: string, encoding?: null): Promise<Buffer>;
  async function readRootFile(
    path: string,
    encoding?: 'utf8' | null,
  ): Promise<string | Buffer> {
    return encoding === 'utf8'
      ? readFile(join(root, path), encoding)
      : readFile(join(root, path));
  }
  const client = new SpritesClient('test-token');
  const filesystem = Object.assign(new SpriteFilesystem(client, 'temporary'), {
    exists: vi.fn(async (path: string): Promise<boolean> => {
      try {
        await access(join(root, path));

        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }

        return false;
      }
    }),
    readFile: readRootFile,
    writeFile: vi.fn(
      async (
        path: string,
        contents: string | Buffer,
        options?: { mode?: number },
      ): Promise<void> => {
        // a provisioned guest always has its guest root and the cron directory
        if (
          path.startsWith('/opt/open-agent/') ||
          path.startsWith('/etc/cron.d/')
        ) {
          await mkdir(join(root, dirname(path)), { recursive: true });
        }
        await writeFile(join(root, path), contents, options);
      },
    ),
    mkdir: vi.fn(
      async (
        path: string,
        options?: { recursive?: boolean; mode?: number },
      ): Promise<void> => {
        await mkdir(join(root, path), options);
      },
    ),
    rename: vi.fn(async (previous: string, next: string): Promise<void> => {
      await rename(join(root, previous), join(root, next));
    }),
    rm: vi.fn(
      async (
        path: string,
        options?: { recursive?: boolean; force?: boolean },
      ): Promise<void> => {
        await rm(join(root, path), options);
      },
    ),
    chmod: vi.fn(async (path: string, mode: number): Promise<void> => {
      await chmod(join(root, path), mode);
    }),
    chown: vi.fn(
      async (path: string, _options: ChownOptions): Promise<void> => {
        await stat(join(root, path));
      },
    ),
  } satisfies Partial<SpriteFilesystem>);

  const sprite = Object.assign(new Sprite('temporary', client), {
    filesystem: (): SpriteFilesystem => filesystem,
    execFile: vi.fn<Sprite['execFile']>(async (file, args = [], options) =>
      execute(file, args, options),
    ),
    execFileHTTP: vi.fn<Sprite['execFileHTTP']>(
      async (file, args = [], options) => execute(file, args, options),
    ),
  } satisfies Partial<Sprite>);

  return sprite;
}

/**
 * supplies canned SDK results for a bounded sequence of native harness calls
 * @param responses observed command arguments and native results
 * @returns typed SDK execution spy with numeric-account responses
 */
export function createNativeCommandExecutor(
  responses: readonly NativeCommandResponse[],
): Sprite['execFile'] {
  const pending = [...responses];

  return vi.fn<Sprite['execFile']>(async (file, args = []) => {
    const harnessIndex = args.findIndex((argument) =>
      ['claude', 'codex', 'git', 'jj', HOMEBREW_GH].includes(argument),
    );
    if (file === '/usr/bin/sudo' && harnessIndex >= 0) {
      const expected = pending.shift();
      const argv = args.slice(harnessIndex);
      if (!expected || JSON.stringify(argv) !== JSON.stringify(expected.argv)) {
        throw new Error(`Unexpected SDK native command: ${argv.join(' ')}`);
      }

      return expected.result;
    }

    return executeNativeConfiguration(file, args);
  });
}

/**
 * supplies bounded SDK responses required by native configuration writes
 * @param file guest executable requested through the SDK
 * @param args guest argument array
 * @returns numeric guest account identity or native hook-trust completion
 */
export async function executeNativeConfiguration(
  file: string,
  args: string[] = [],
): Promise<ExecResult> {
  const [program, flag, account] = args.slice(-3);
  if (
    file === '/usr/bin/sudo' &&
    args.includes('--') &&
    program === '/usr/bin/id' &&
    ['-u', '-g'].includes(flag ?? '')
  ) {
    return {
      stdout: account === 'sprite' ? '1001\n' : '1000\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (
    file === '/usr/bin/sudo' &&
    args.includes(
      '/opt/open-agent/drivers/harnesses/codex/guest/codex-hooks-trust.js',
    )
  ) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  throw new Error(`Unexpected SDK command: ${file} ${args.join(' ')}`);
}
