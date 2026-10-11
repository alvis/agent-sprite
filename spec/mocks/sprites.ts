import { EventEmitter } from 'node:events';
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { Sprite, SpriteFilesystem, SpritesClient } from '@fly/sprites';
import { vi } from 'vitest';

import {
  ensureNativeDirectory,
  removeNativeFile,
  writeNativeFile,
} from '#scripts/native-files';

import type { ChownOptions, ExecResult, SpriteCommand } from '@fly/sprites';

import type { TransactionRequest } from '#integrations/guest/transaction/protocol';

/** inputs for a Sprite SDK boundary backed by an isolated local filesystem */
export interface FilesystemSpriteParams {
  root: string;
  execute?: Sprite['execFile'];
  chownRecords?: FilesystemChownRecord[];
}

/** observed ownership mutation at the SDK filesystem boundary */
export interface FilesystemChownRecord {
  path: string;
  uid: ChownOptions['uid'];
  gid: ChownOptions['gid'];
}

/** one observed SDK native command response in execution order */
export interface NativeCommandResponse {
  argv: string[];
  result: ExecResult;
}

/**
 * creates an SDK filesystem boundary that performs real temporary-file operations
 * @param params temporary root and optional native command response boundary
 * @returns Sprite whose filesystem paths are rooted in the temporary directory
 */
export function createFilesystemSprite(params: FilesystemSpriteParams): Sprite {
  const { root, execute = executeNativeConfiguration, chownRecords } = params;
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
        if (path.startsWith('/opt/agent-sprite/native-files.js')) {
          await mkdir(join(root, '/opt/agent-sprite'), { recursive: true });
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
    chown: vi.fn(async (path: string, options: ChownOptions): Promise<void> => {
      await stat(join(root, path));
      chownRecords?.push({ path, uid: options.uid, gid: options.gid });
    }),
  } satisfies Partial<SpriteFilesystem>);

  const sprite = Object.assign(new Sprite('temporary', client), {
    filesystem: (): SpriteFilesystem => filesystem,
    execFile: vi.fn<Sprite['execFile']>(async (file, args = [], options) => {
      const native = await executeNativeFileCommand({ root, file, args });

      return native ?? execute(file, args, options);
    }),
    execFileHTTP: vi.fn<Sprite['execFileHTTP']>(
      async (file, args = [], options) => {
        const native = await executeNativeFileCommand({
          root,
          file,
          args,
          input: options?.input,
        });

        return native ?? execute(file, args, options);
      },
    ),
    spawn: vi.fn<Sprite['spawn']>((_command, args = []) =>
      createSdkTransactionStream(sprite, filesystem, args.at(-1) === '1'),
    ),
  } satisfies Partial<Sprite>);

  return sprite;
}

/**
 * forwards framed transaction primitives to the existing SDK unit boundary
 * without simulating flock, worker scheduling, or guest process ownership
 * @param sprite SDK mock with real temporary filesystem handlers
 * @param filesystem existing SDK filesystem mock
 * @param _bootstrap whether missing managed Node may be bootstrapped
 * @returns an SDK command-shaped stream for the host transaction client
 */
function createSdkTransactionStream(
  sprite: Sprite,
  filesystem: SpriteFilesystem,
  _bootstrap: boolean,
): SpriteCommand {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const shape = {
    stdin,
    stdout,
    stderr,
    close: vi.fn(() => {
      closed = true;
      stdout.end();
      stderr.end();
    }),
  } satisfies Partial<SpriteCommand>;
  const command = Object.assign(new EventEmitter(), shape);
  let closed = false;
  let buffer = '';
  let payloads = 3;
  let begun = false;
  let ready = false;
  let ended = false;
  let pending = 0;
  const transient = new Set<string>();
  const emit = (event: object): void => {
    if (!closed) {
      stdout.write(`${JSON.stringify(event)}\n`);
    }
  };
  const release = async (): Promise<void> => {
    if (closed || !ended || pending > 0 || !ready) {
      return;
    }
    const cleanup = await Promise.allSettled(
      [...transient].map(async (path) => filesystem.rm(path, { force: true })),
    );
    emit({
      type: 'released',
      cleanupFailed: cleanup.some((result) => result.status === 'rejected'),
    });
  };
  const accept = (request: TransactionRequest & { id: number }): void => {
    emit({ type: 'accepted', id: request.id });
    pending++;
    void dispatchSdkTransaction({ sprite, filesystem, request, transient })
      .then(
        (result) => emit({ type: 'settled', id: request.id, result }),
        (error: NodeJS.ErrnoException) =>
          emit({
            type: 'settled',
            id: request.id,
            failure: error.code ?? 'FAILED',
          }),
      )
      .finally(() => {
        pending--;
        void release();
      });
  };
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!begun) {
        begun = line === 'begin';
        continue;
      }
      if (payloads > 0) {
        payloads--;
        if (payloads === 0) {
          ready = true;
          emit({ type: 'ready', installed: false });
        }
        continue;
      }
      const frame: unknown = JSON.parse(line);
      if (
        typeof frame === 'object' &&
        frame !== null &&
        'type' in frame &&
        frame.type !== 'heartbeat'
      ) {
        accept(frame as TransactionRequest & { id: number });
      }
    }
  });
  stdin.on('end', () => {
    ended = true;
    void release();
  });
  queueMicrotask(() => stdout.write('locked\n'));

  return command as Pick<
    SpriteCommand,
    'stdin' | 'stdout' | 'stderr' | 'close'
  > as SpriteCommand;
}

/**
 * maps one accepted request to the SDK methods already backed by temp files
 * @param params SDK command and filesystem dispatch inputs
 * @param params.sprite mocked SDK guest
 * @param params.filesystem mocked SDK filesystem
 * @param params.request framed primitive and request ID
 * @param params.transient paths cleaned when the stream closes
 * @returns primitive result after the existing SDK handler settles
 */
async function dispatchSdkTransaction(params: {
  sprite: Sprite;
  filesystem: SpriteFilesystem;
  request: TransactionRequest & { id: number };
  transient: Set<string>;
}): Promise<object> {
  const { sprite, filesystem, request, transient } = params;
  switch (request.type) {
    case 'run': {
      const [file, ...args] = request.argv;
      const options = { input: request.input, env: request.env };
      const result =
        request.input === undefined
          ? await sprite.execFile(
              '/usr/bin/sudo',
              ['-n', '-E', '--', file!, ...args],
              options,
            )
          : await sprite.execFileHTTP(
              '/usr/bin/sudo',
              ['-n', '-E', '--', file!, ...args],
              options,
            );

      return {
        stdout: String(result.stdout),
        stderr: String(result.stderr),
        exitCode: result.exitCode,
      };
    }
    case 'read':
      return {
        contents: String(await filesystem.readFile(request.path, 'utf8')),
      };
    case 'exists':
      return { exists: await filesystem.exists(request.path) };
    case 'write':
      if (request.removeOnRelease) {
        transient.add(request.path);
      }
      await filesystem.writeFile(request.path, request.contents, {
        mode: request.mode,
      });

      return {};
    case 'chown':
      await filesystem.chown(request.path, {
        uid: request.uid,
        gid: request.gid,
        asRoot: true,
      });

      return {};
    case 'remove':
      await filesystem.rm(request.path, { force: true, asRoot: true });

      return {};
    default:
      throw new Error('Unexpected transaction request');
  }
}

/**
 * runs native SDK commands against the real helper in the isolated host tree
 * @param params isolated root, SDK command and optional HTTP stdin
 * @param params.root isolated Sprite filesystem root
 * @param params.file SDK executable
 * @param params.args SDK argument array
 * @param params.input HTTP stdin for private writes
 * @returns helper completion, or undefined for another command
 */
async function executeNativeFileCommand(params: {
  root: string;
  file: string;
  args: string[];
  input?: string | Buffer;
}): Promise<ExecResult | undefined> {
  const { root, file, args, input } = params;
  const [
    sudoN,
    sudoE,
    sudoEnd,
    runuser,
    userFlag,
    user,
    userEnd,
    node,
    script,
    operation,
    home,
    path,
  ] = args;
  if (
    file !== '/usr/bin/sudo' ||
    sudoN !== '-n' ||
    sudoE !== '-E' ||
    sudoEnd !== '--' ||
    runuser !== '/usr/sbin/runuser' ||
    userFlag !== '-u' ||
    !['agent', 'sprite'].includes(user ?? '') ||
    userEnd !== '--' ||
    node !== '/opt/agent-sprite/node/bin/node' ||
    script !== '/opt/agent-sprite/native-files.js'
  ) {
    return undefined;
  }
  if (home !== `/home/${user}` || !path) {
    throw new Error('Unexpected native helper arguments');
  }
  const canonicalRoot = await realpath(root);
  const mappedHome = join(canonicalRoot, home);
  const mappedPath = join(canonicalRoot, path);
  await mkdir(mappedHome, { recursive: true });
  switch (operation) {
    case 'mkdir':
      await ensureNativeDirectory({ home: mappedHome, path: mappedPath });
      break;
    case 'write':
      if (input === undefined) {
        throw new Error('Native helper write requires HTTP stdin');
      }
      await writeNativeFile({
        home: mappedHome,
        path: mappedPath,
        contents: String(input),
      });
      break;
    case 'remove':
      await removeNativeFile({ home: mappedHome, path: mappedPath });
      break;
    default:
      throw new Error('Unexpected native helper operation');
  }

  return { stdout: '', stderr: '', exitCode: 0 };
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
      ['claude', 'codex', 'git', 'jj', '/opt/agent-sprite/tools/gh'].includes(
        argument,
      ),
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
    args.includes('/opt/agent-sprite/codex-hooks-trust.js')
  ) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  throw new Error(`Unexpected SDK command: ${file} ${args.join(' ')}`);
}
