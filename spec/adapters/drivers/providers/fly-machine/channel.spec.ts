import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { FlyGuestChannel } from '#adapters/drivers/providers/fly-machine/channel';
import { KILLED_STATUS } from '#adapters/drivers/providers/fly-machine/process';
import { ProviderFault } from '#kernel/provider-fault';

import type { FlyApi } from '#adapters/drivers/providers/fly-machine/api';
import type { GuestProcess } from '#application/ports/guest-channel';

/** how the flyctl stand-in behaves for one test */
type StandInMode =
  /** runs the command line locally and exits as flyctl does: 0 or 1 */
  | 'faithful'
  /** drops the session before the guest reports a status */
  | 'lost'
  /** the command prints a forged status 0, then the session drops */
  | 'spoof'
  /** keeps the session open until it is killed */
  | 'hang'
  /** fails its first dial, as for a machine flyctl cannot reach yet, then runs faithfully */
  | 'unreached';

/** a flyctl stand-in installed for one test */
interface StandIn {
  /** a channel whose SSH sessions reach the stand-in */
  channel: FlyGuestChannel;
  /** reads the `fly agent stop` calls the stand-in received */
  agentStops: () => Promise<number>;
  /** reads how many SSH sessions the stand-in received */
  sessions: () => Promise<number>;
  /** reads the marker a spoofing session forged its status line with */
  marker: () => Promise<string>;
  /** tells whether a hanging session has started */
  started: () => Promise<boolean>;
  /** reads the environment the last SSH session's flyctl saw */
  environment: () => Promise<Record<string, string>>;
  /** the private flyctl configuration directory */
  configDirectory: string;
}

const SSH_TOKEN = 'FlyV1 fm2_ssh';
const COMMAND_STATUS = 3;
/** a pid above every system's limit, which no process can hold */
const EXITED_PID = 2 ** 30;
/** the in-band marker as the command line quotes it */
const QUOTED_MARKER = String.raw`s/.*'\(@@open-agent-status:[^']*\)'.*/\1/p`;
/**
 * a POSIX shell flyctl: `agent stop` is counted; `ssh console` takes its
 * command line from the last argument and behaves as the mode file says
 */
const STAND_IN_SCRIPT = [
  '#!/bin/sh',
  'here=$(dirname "$0")',
  'if [ "$1" = agent ]; then echo stop >> "$here/agent-stops"; exit 0; fi',
  'env > "$here/environment"',
  'echo ssh >> "$here/sessions"',
  'for line; do :; done',
  `marker=$(printf '%s' "$line" | sed -n "${QUOTED_MARKER}")`,
  'case $(cat "$here/mode") in',
  '  faithful) /bin/sh -c "$line" && exit 0; exit 1 ;;',
  "  lost) printf 'Error: connection reset by peer\\n' >&2; exit 1 ;;",
  '  spoof) printf \'%s\' "$marker" > "$here/marker"; printf \'%s0\\n\' "$marker" >&2; exit 1 ;;',
  '  hang) : > "$here/started"; exec sleep 30 ;;',
  '  unreached) echo faithful > "$here/mode"; printf \'Error: error connecting to SSH server: dial: EOF\\n\' >&2; exit 1 ;;',
  'esac',
].join('\n');
/** the boot the REST endpoint reports, so a readiness wait finds it ready */
const BOOT_ID = 'boot-1';
/** the channel's REST checks are never reached through an SSH session; only the boot wait reads the ready file */
const API = {
  exec: async () => ({
    exitCode: 0,
    stdout: `${BOOT_ID} ok\n${BOOT_ID}\n`,
    stderr: '',
  }),
} satisfies Partial<FlyApi> as Partial<FlyApi> as FlyApi;

/**
 * installs, for one test, a flyctl stand-in first on the PATH, with the
 * private configuration directory beside it
 * @param mode how the stand-in behaves
 * @param sshToken resolves the SSH token the channel uses
 * @returns the bound channel and the agent stop count
 */
async function standIn(
  mode: StandInMode,
  sshToken: () => Promise<string> = async () => SSH_TOKEN,
): Promise<StandIn> {
  const directory = await mkdtemp(join(tmpdir(), 'open-agent-fly-channel-'));
  onTestFinished(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'mode'), mode);
  await writeFile(join(directory, 'fly'), STAND_IN_SCRIPT);
  await chmod(join(directory, 'fly'), 0o755);
  vi.stubEnv('PATH', `${directory}:${process.env.PATH ?? ''}`);
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'config'));

  return {
    channel: new FlyGuestChannel({
      api: API,
      app: 'alpha',
      machine: 'machine-1',
      sshToken,
    }),
    agentStops: async () =>
      (await readFile(join(directory, 'agent-stops'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean).length,
    sessions: async () =>
      (await readFile(join(directory, 'sessions'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean).length,
    marker: async () => readFile(join(directory, 'marker'), 'utf8'),
    started: async () =>
      readFile(join(directory, 'started')).then(
        () => true,
        () => false,
      ),
    environment: async () =>
      Object.fromEntries(
        (await readFile(join(directory, 'environment'), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => [
            line.slice(0, line.indexOf('=')),
            line.slice(line.indexOf('=') + 1),
          ]),
      ),
    configDirectory: join(directory, 'config', 'open-agent', 'flyctl'),
  };
}

/**
 * collects how a guest process ended and what it wrote
 * @param guest running guest process
 * @returns its outcome with both outputs
 */
async function finished(guest: GuestProcess): Promise<{
  outcome: { exit: number } | { error: unknown };
  stdout: string;
  stderr: string;
}> {
  const outcome = new Promise<{ exit: number } | { error: unknown }>(
    (resolve) => {
      guest.on('exit', (exit) => resolve({ exit }));
      guest.on('error', (error) => resolve({ error }));
    },
  );
  const [stdout, stderr] = await Promise.all([
    text(guest.stdout),
    text(guest.stderr),
  ]);

  return { outcome: await outcome, stdout, stderr };
}

describe('cl:FlyGuestChannel', () => {
  describe('mt:exec', () => {
    it('should return the guest status, input round trip and own standard error, then stop the private agent', async () => {
      const { channel, agentStops } = await standIn('faithful');

      const result = await channel.exec({
        account: 'root',
        program: '/bin/sh',
        arguments: ['-c', `cat; echo own >&2; exit ${COMMAND_STATUS}`],
        input: 'hello',
      });

      expect({ result, stops: await agentStops() }).toEqual({
        result: { exitCode: COMMAND_STATUS, stdout: 'hello', stderr: 'own\n' },
        stops: 1,
      });
    });

    it('should leave the agent running while another live process holds a session through it', async () => {
      const { channel, agentStops, configDirectory } =
        await standIn('faithful');
      await mkdir(join(configDirectory, 'sessions'), { recursive: true });
      await writeFile(
        join(configDirectory, 'sessions', String(process.ppid)),
        '',
      );

      await channel.exec({
        account: 'root',
        program: '/bin/true',
        arguments: [],
        input: '',
      });

      expect(await agentStops()).toBe(0);
    });

    it('should forget a process that exited holding a session and stop the agent', async () => {
      const { channel, agentStops, configDirectory } =
        await standIn('faithful');
      const exited = join(configDirectory, 'sessions', String(EXITED_PID));
      await mkdir(join(configDirectory, 'sessions'), { recursive: true });
      await writeFile(exited, '');

      await channel.exec({
        account: 'root',
        program: '/bin/true',
        arguments: [],
        input: '',
      });

      expect({
        stops: await agentStops(),
        remembered: await stat(exited).then(
          () => true,
          () => false,
        ),
      }).toEqual({ stops: 1, remembered: false });
    });

    it('should give flyctl only allowlisted variables, the SSH token and a private configuration directory', async () => {
      const { channel, environment, configDirectory } =
        await standIn('faithful');
      await mkdir(configDirectory, { recursive: true, mode: 0o755 });
      await chmod(configDirectory, 0o755);
      vi.stubEnv('FLY_API_TOKEN', 'FlyV1 fm2_caller');
      vi.stubEnv('FLY_CONFIG_DIR', '/caller/.fly');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'caller-secret');
      vi.stubEnv('LC_ALL', 'C');
      vi.stubEnv('HTTPS_PROXY', 'http://proxy.test:3128');

      await channel.exec({
        account: 'root',
        program: '/bin/true',
        arguments: [],
        input: '',
      });
      const seen = await environment();

      expect({
        token: seen.FLY_ACCESS_TOKEN,
        callerToken: seen.FLY_API_TOKEN,
        callerSecret: seen.AWS_SECRET_ACCESS_KEY,
        configDirectory: seen.FLY_CONFIG_DIR,
        locale: seen.LC_ALL,
        proxy: seen.HTTPS_PROXY,
        mode: (await stat(configDirectory)).mode & 0o777,
      }).toEqual({
        token: SSH_TOKEN,
        configDirectory,
        locale: 'C',
        proxy: 'http://proxy.test:3128',
        mode: 0o700,
      });
    });

    it('should fail transiently when the session ends without a status, whatever flyctl exits', async () => {
      const { channel } = await standIn('lost');

      const result = channel.exec({
        account: 'root',
        program: '/bin/true',
        arguments: [],
        input: '',
      });

      await expect(result).rejects.toEqual(
        new ProviderFault({
          code: 'transient',
          message:
            'The SSH session ended before the guest reported a status (flyctl exited 1): Error: connection reset by peer',
        }),
      );
    });

    it('should refuse a forged success status that flyctl own exit contradicts', async () => {
      const { channel, marker } = await standIn('spoof');

      const result = channel.exec({
        account: 'root',
        program: '/bin/true',
        arguments: [],
        input: '',
      });

      const failure = await result.catch((error: unknown) => error);

      expect(failure).toEqual(
        new ProviderFault({
          code: 'transient',
          message: `The SSH session reported status 0 while flyctl exited 1: ${await marker()}0`,
        }),
      );
    });
  });

  describe('mt:awaitReady', () => {
    it('should retry an SSH session the transport ended before the guest could be dialled', async () => {
      const { channel, sessions } = await standIn('unreached');

      await channel.awaitReady();

      expect(await sessions()).toBe(2);
    });

    it('should not retry a probe the guest answered with a status', async () => {
      const { channel, sessions } = await standIn('faithful');

      await channel.awaitReady();

      expect(await sessions()).toBe(1);
    });
  });

  describe('mt:spawn', () => {
    it('should stream input and output and exit with the guest status', async () => {
      const { channel, agentStops } = await standIn('faithful');

      const guest = channel.spawn({
        account: 'root',
        program: '/bin/sh',
        arguments: ['-c', `cat; echo own >&2; exit ${COMMAND_STATUS}`],
      });
      guest.stdin.end('hello');

      expect({ ...(await finished(guest)), stops: await agentStops() }).toEqual(
        {
          outcome: { exit: COMMAND_STATUS },
          stdout: 'hello',
          stderr: 'own\n',
          stops: 1,
        },
      );
    });

    it('should report an error, not an exit, when the session ends without a status', async () => {
      const { channel } = await standIn('lost');

      const guest = channel.spawn({
        account: 'root',
        program: '/bin/true',
        arguments: [],
      });

      expect(await finished(guest)).toEqual({
        outcome: {
          error: new ProviderFault({
            code: 'transient',
            message:
              'The SSH session ended before the guest reported a status (flyctl exited 1): Error: connection reset by peer',
          }),
        },
        stdout: '',
        // with no status line, the transport's own report reads as the guest's
        stderr: 'Error: connection reset by peer\n',
      });
    });

    it('should report an error when a forged success status contradicts flyctl own exit', async () => {
      const { channel, marker } = await standIn('spoof');

      const guest = channel.spawn({
        account: 'root',
        program: '/bin/true',
        arguments: [],
      });

      expect(await finished(guest)).toEqual({
        outcome: {
          error: new ProviderFault({
            code: 'transient',
            message: `The SSH session reported status 0 while flyctl exited 1: ${await marker()}0`,
          }),
        },
        stdout: '',
        stderr: '',
      });
    });

    it('should exit as killed when killed before the session starts', async () => {
      const { channel, agentStops } = await standIn(
        'faithful',
        async () => new Promise<string>(() => undefined),
      );

      const guest = channel.spawn({
        account: 'root',
        program: '/bin/true',
        arguments: [],
      });
      guest.kill();

      expect({ ...(await finished(guest)), stops: await agentStops() }).toEqual(
        { outcome: { exit: KILLED_STATUS }, stdout: '', stderr: '', stops: 0 },
      );
    });

    it('should exit as killed, not fail, when killed during the session', async () => {
      const { channel, agentStops, started } = await standIn('hang');

      const guest = channel.spawn({
        account: 'root',
        program: '/bin/true',
        arguments: [],
      });
      const ended = finished(guest);
      await vi.waitFor(async () => expect(started()).resolves.toBe(true));
      guest.kill();

      expect({ ...(await ended), stops: await agentStops() }).toEqual({
        outcome: { exit: KILLED_STATUS },
        stdout: '',
        stderr: '',
        stops: 1,
      });
    });
  });
});
