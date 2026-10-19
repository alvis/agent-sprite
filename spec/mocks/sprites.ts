import {
  access,
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ServiceLogStream,
  Sprite,
  SpriteCommand,
  SpriteFilesystem,
  SpritesClient,
} from '@fly/sprites';
import { vi } from 'vitest';

import { SpriteGuestChannel } from '#adapters/drivers/providers/sprite/channel';
import { SpriteProvider } from '#adapters/drivers/providers/sprite/provider';
import { toRecord } from '#adapters/drivers/providers/sprite/records';
import { sessionGuest } from '#adapters/guest/platform/session/channel';
import { HOMEBREW_GH } from '#adapters/guest/tools/accounts';
import { registry } from '#composition/registry';

import { dependencies } from './dependencies';
import { standInSession } from './session';

import type {
  ExecResult,
  HTTPExecOptions,
  ServiceWithState,
} from '@fly/sprites';

import type { SessionGuest } from '#adapters/guest/platform/session/channel';
import type { ProviderDriver } from '#application/ports/drivers';
import type { SetupSession } from '#application/ports/session';
import type { WorkstationRecord } from '#domain/workstation';

// the agent services core lets a provider stop and restore, as core binds them
const restorableServices = Object.values(registry.agents).map(
  ({ service }) => service.name,
);

/** runs one guest command through the SDK, with its input when it has one */
export type GuestExecute = (
  file: string,
  args?: string[],
  options?: HTTPExecOptions,
) => Promise<ExecResult>;

/** inputs for a Sprite SDK boundary backed by an isolated local filesystem */
export interface FilesystemSpriteParams {
  root: string;
  /** the workstation's name, `temporary` unless given */
  name?: string;
  /** answers every command other than the guest file programs */
  execute?: GuestExecute;
}

/** one observed SDK native command response in execution order */
export interface NativeCommandResponse {
  argv: string[];
  result: ExecResult;
}

/** privilege program every guest command runs behind */
const SUDO = '/usr/bin/sudo';
/** program a command runs behind to drop to an account */
const RUNUSER = '/usr/sbin/runuser';
/** name the root write program runs under */
const WRITE_NAME = 'oa-write';
/** name a plan's file step runs its check and install under */
const FILE_STEP_NAME = 'oa-file';
/** how a file step's install program begins, where its check tests the file */
const FILE_INSTALL_START = 'umask';
/** name the home files program runs under */
const HOME_FILES_NAME = 'oa-home-files';
/** name the release guard's read runs under */
const RELEASE_NAME = 'open-agent-release';
/** status the release guard's read exits with when nothing is recorded */
const ABSENT_STATUS = 3;
/** the radix the write program reads a mode in */
const OCTAL = 8;
/** mode the home files program makes a directory with */
const PRIVATE_DIRECTORY_MODE = 0o700;
/** mode the home files program writes a file with */
const PRIVATE_FILE_MODE = 0o600;

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
 * presents an SDK mock through a setup session's guest channel, whose
 * commands, and the secrets they take as input, reach the mock's exec
 * @param sprite SDK mock
 * @returns the session channel over the mock's driver channel
 */
export function sessionGuestOf(sprite: Sprite): SessionGuest {
  const channel = guestOf(sprite);

  return sessionGuest(standInSession(channel), channel, channel.services);
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
 * keeps the SDK mock's services in memory: a created service runs at once,
 * a deleted one is gone, and the registry endpoint lists them
 * @param sprite SDK mock
 * @returns the services the mock holds, by name
 */
export function holdServices(sprite: Sprite): Map<string, ServiceWithState> {
  const services = new Map<string, ServiceWithState>();
  vi.spyOn(sprite, 'listServices').mockImplementation(async () => [
    ...services.values(),
  ]);
  vi.spyOn(sprite, 'getService').mockImplementation(async (name) => {
    const service = services.get(name);
    if (!service) {
      throw new Error(`Service ${name} not found`);
    }

    return service;
  });
  vi.spyOn(sprite, 'createService').mockImplementation(
    async (name, request) => {
      services.set(name, {
        name,
        cmd: request.cmd,
        args: request.args ?? [],
        needs: request.needs ?? [],
        state: { name, status: 'running' },
      });

      return new ServiceLogStream(
        new Response('{"type":"complete","timestamp":0}\n'),
      );
    },
  );
  vi.spyOn(sprite, 'stopService').mockImplementation(async (name) => {
    const service = services.get(name);
    if (service) {
      service.state = { name, status: 'stopped' };
    }

    return new ServiceLogStream(
      new Response('{"type":"complete","timestamp":0}\n'),
    );
  });
  vi.spyOn(sprite, 'deleteService').mockImplementation(async (name) => {
    services.delete(name);
  });
  serveServiceRegistry(sprite);

  return services;
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
  connection: SetupSession;
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
    connection: dependencies.guest.session.connect({
      provider,
      workstation,
    }),
  };
}

/**
 * creates an SDK boundary that performs real temporary-file operations: the
 * filesystem API reads, and seeds, below the root, and the guest file
 * programs setup runs through exec are carried out there too
 * @param params temporary root and optional native command response boundary
 * @returns Sprite whose filesystem paths are rooted in the temporary directory
 */
export function createFilesystemSprite(params: FilesystemSpriteParams): Sprite {
  const {
    root,
    name = 'temporary',
    execute = executeNativeConfiguration,
  } = params;
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
  const filesystem = Object.assign(new SpriteFilesystem(client, name), {
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
    // setup changes guest files only through exec; these seed a spec's guest
    writeFile: async (
      path: string,
      contents: string | Buffer,
      options?: { mode?: number },
    ): Promise<void> => {
      await mkdir(join(root, dirname(path)), { recursive: true });
      await writeFile(join(root, path), contents, options);
    },
    mkdir: async (
      path: string,
      options?: { recursive?: boolean; mode?: number },
    ): Promise<void> => {
      await mkdir(join(root, path), options);
    },
    rm: async (
      path: string,
      options?: { recursive?: boolean; force?: boolean },
    ): Promise<void> => {
      await rm(join(root, path), options);
    },
  } satisfies Partial<SpriteFilesystem>);
  const run: GuestExecute = async (file, args = [], options) =>
    (await emulateGuestFiles(root, guestCommand(file, args), options?.input)) ??
    execute(file, args, options);

  const sprite = Object.assign(new Sprite(name, client), {
    filesystem: (): SpriteFilesystem => filesystem,
    execFile: vi.fn<Sprite['execFile']>(async (file, args, options) =>
      run(file, args, options),
    ),
    execFileHTTP: vi.fn<Sprite['execFileHTTP']>(async (file, args, options) =>
      run(file, args, options),
    ),
    spawn: vi.fn<Sprite['spawn']>((file, args = []) =>
      failedProcess(sprite, file, args),
    ),
  } satisfies Partial<Sprite>);

  return sprite;
}

/**
 * stands in for a guest process no spec reaches: the SDK command is never
 * started, so it opens no WebSocket, and it fails as a lost transport would
 * @param sprite SDK mock the process belongs to
 * @param file guest executable requested through the SDK
 * @param args guest argument array
 * @returns an unstarted SDK command that reports a transport error
 */
function failedProcess(
  sprite: Sprite,
  file: string,
  args: string[],
): SpriteCommand {
  const command = new SpriteCommand(sprite, file, args);
  process.nextTick(() =>
    command.emit(
      'error',
      new Error(`Unexpected SDK spawn: ${file} ${args.join(' ')}`),
    ),
  );

  return command;
}

/**
 * lists the guest files a Sprite mock's exec wrote, in order: root files the
 * write program replaced and home files the home files program wrote; every
 * write carries its contents as input, so it goes through the HTTP exec
 * @param sprite SDK mock from {@link createFilesystemSprite}
 * @returns each written guest path
 */
export function writtenPaths(sprite: Sprite): string[] {
  return vi.mocked(sprite.execFileHTTP).mock.calls.flatMap(([file, args]) => {
    const command = guestCommand(file, args);
    const [rootPath] = programArguments(command, WRITE_NAME) ?? [];
    const [operation, , homePath] =
      programArguments(command, HOME_FILES_NAME) ?? [];
    const path = rootPath ?? (operation === 'write' ? homePath : undefined);

    return path === undefined ? [] : [path];
  });
}

/**
 * strips the privilege and account prefixes a guest command runs behind
 * @param file guest executable requested through the SDK
 * @param args guest argument array
 * @returns the program and its arguments
 */
function guestCommand(file: string, args: readonly string[] = []): string[] {
  let command =
    file === SUDO ? args.slice(args.indexOf('--') + 1) : [file, ...args];
  while (command[0] === RUNUSER) {
    command = command.slice(command.indexOf('--') + 1);
  }

  return command;
}

/**
 * reads the arguments of an inline shell program run under a name
 * @param command the program and its arguments
 * @param name the name the program runs under, its `$0`
 * @returns its arguments, or nothing when the command is another
 */
function programArguments(
  command: readonly string[],
  name: string,
): string[] | undefined {
  const [, flag, , named, ...rest] = command;

  // the family's shell runs a plan's programs, `/bin/sh` the channel's own
  return flag === '-c' && named === name ? rest : undefined;
}

/**
 * carries out a guest file program below the root: the root write program,
 * a plan's file step, the home files program, a root file removal and the
 * release guard's read
 * @param root directory standing for the guest filesystem
 * @param command the guest command with its privilege prefix stripped
 * @param input the command's standard input
 * @returns the program's outcome, or nothing when the command is another
 */
async function emulateGuestFiles(
  root: string,
  command: readonly string[],
  input: string | Buffer | undefined,
): Promise<ExecResult | undefined> {
  const [writePath, writeMode] = programArguments(command, WRITE_NAME) ?? [];
  const home = programArguments(command, HOME_FILES_NAME);
  const [releasePath] = programArguments(command, RELEASE_NAME) ?? [];
  const [filePath, fileMode] = programArguments(command, FILE_STEP_NAME) ?? [];
  if (filePath !== undefined && fileMode !== undefined) {
    return emulateFileStep(root, {
      install: command[2]?.startsWith(FILE_INSTALL_START) ?? false,
      path: filePath,
      mode: parseInt(fileMode, OCTAL),
      contents: String(input ?? ''),
    });
  }
  if (writePath !== undefined && writeMode !== undefined) {
    await mkdir(join(root, dirname(writePath)), { recursive: true });
    await writeFile(join(root, writePath), input ?? '');
    await chmod(join(root, writePath), parseInt(writeMode, OCTAL));

    return succeeded();
  }
  if (home) {
    return emulateHomeFile(root, home, input);
  }
  if (command[0] === 'rm' && command[1] === '-f' && command[2] === '--') {
    await rm(join(root, command[3] ?? ''), { force: true });

    return succeeded();
  }
  if (releasePath !== undefined) {
    try {
      return succeeded(await readFile(join(root, releasePath), 'utf8'));
    } catch {
      return { stdout: '', stderr: '', exitCode: ABSENT_STATUS };
    }
  }

  return undefined;
}

/**
 * carries out a plan's file step below the root: its install writes the
 * file with its mode, its check passes once the file holds the contents with
 * that mode
 * @param root directory standing for the guest filesystem
 * @param step whether it installs, and the path, mode and contents
 * @param step.install whether the step installs rather than checks
 * @param step.path where on the guest the file lives
 * @param step.mode permission bits the file must carry
 * @param step.contents text the step's input carries
 * @returns the program's outcome
 */
async function emulateFileStep(
  root: string,
  step: { install: boolean; path: string; mode: number; contents: string },
): Promise<ExecResult> {
  const target = join(root, step.path);
  if (step.install) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, step.contents);
    await chmod(target, step.mode);

    return succeeded();
  }
  try {
    const [{ mode }, contents] = await Promise.all([
      stat(target),
      readFile(target, 'utf8'),
    ]);

    return (mode & 0o777) === step.mode && contents === step.contents
      ? succeeded()
      : notInPlace();
  } catch {
    return notInPlace();
  }
}

/**
 * carries out the home files program below the root; like the program, a
 * write needs its parent directory already made
 * @param root directory standing for the guest filesystem
 * @param home the operation, the home and the path inside it
 * @param input the written contents
 * @returns the program's outcome
 */
async function emulateHomeFile(
  root: string,
  home: readonly string[],
  input: string | Buffer | undefined,
): Promise<ExecResult> {
  const [operation, , path = ''] = home;
  const target = join(root, path);
  switch (operation) {
    case 'mkdir':
      await mkdir(target, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      await chmod(target, PRIVATE_DIRECTORY_MODE);

      return succeeded();
    case 'write':
      try {
        await stat(dirname(target));
      } catch {
        return refused(`${dirname(path)} is not the account's own directory`);
      }
      // the program replaces the file with a private temporary one
      await writeFile(target, input ?? '');
      await chmod(target, PRIVATE_FILE_MODE);

      return succeeded();
    case 'remove':
      await rm(target, { force: true });

      return succeeded();
    default:
      return refused(`unknown operation ${operation}`);
  }
}

/**
 * the outcome of a program that succeeded
 * @param stdout what it printed
 * @returns a zero exit with the output
 */
function succeeded(stdout = ''): ExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

/**
 * the outcome of the home files program refusing a change
 * @param reason why it refused
 * @returns a failed exit naming the reason
 */
function refused(reason: string): ExecResult {
  return { stdout: '', stderr: `home files: ${reason}\n`, exitCode: 1 };
}

/**
 * builds the silent failure a file step's check exits with
 * @returns a check that found the file not in place
 */
function notInPlace(): ExecResult {
  return { stdout: '', stderr: '', exitCode: 1 };
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
    if (file === SUDO && harnessIndex >= 0) {
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
 * supplies the numeric guest account identities native configuration reads
 * @param file guest executable requested through the SDK
 * @param args guest argument array
 * @returns numeric guest account identity
 */
export async function executeNativeConfiguration(
  file: string,
  args: string[] = [],
): Promise<ExecResult> {
  const [program, flag, account] = args.slice(-3);
  if (
    file === SUDO &&
    args.includes('--') &&
    program === '/usr/bin/id' &&
    ['-u', '-g'].includes(flag ?? '')
  ) {
    return succeeded(account === 'sprite' ? '1001\n' : '1000\n');
  }
  throw new Error(`Unexpected SDK command: ${file} ${args.join(' ')}`);
}
