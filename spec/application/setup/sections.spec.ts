import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_ENV_PATH } from '#adapters/guest/platform/layout';
import {
  setupAgent,
  setupEnvironment,
  setupGit,
  setupGithub,
  stopService,
  setupSystem,
} from '#application/setup/sections';

import { PairingSecret } from '#kernel/pairing-secret';
import { revealSecret } from '#kernel/secret';

import { driveInk } from '../../fixtures/ink';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';

import { dependencies, dependenciesWith } from '../../mocks/dependencies';
import {
  createFilesystemSprite,
  holdServices,
  workstationOf,
} from '../../mocks/sprites';

import type { GuestChannel } from '#application/ports/guest-channel';
import type { SetupContext } from '#application/setup/context';

// setup's root session is a framed guest shell only the live specs open
vi.mock(
  '#adapters/guest/platform/session/open',
  async () => import('../../mocks/session'),
);
// Codex trusts its hooks through its app server, a guest process only the live specs run
vi.mock(
  '#adapters/drivers/harnesses/codex/hook-trust',
  () =>
    ({
      trustCodexHooks: vi.fn(async () => undefined),
    }) satisfies Pick<
      typeof import('#adapters/drivers/harnesses/codex/hook-trust'),
      'trustCodexHooks'
    >,
);

describe('fn:setupAgent', () => {
  it('should report a native pairing without expiry metadata without exposing its token', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-pairing-policy-'),
    );
    const token = 'native-policy-private-token';
    const { context, guest } = await quietSetup(
      { withPairCode: true },
      directory.path,
      async () => ({ stdout: `Token: ${token}\n`, stderr: '', exitCode: 0 }),
    );
    const observed = await driveInk(
      async (interaction) =>
        setupAgent(dependencies, guest, { ...context, interaction }),
      [],
    );

    expect({
      status: observed.result.pairing.status,
      token: observed.result.pairing.token?.disclose(true),
      expiresAt: observed.result.pairing.expiresAt,
      started: context.mutation.started,
    }).toEqual({
      status: 'created',
      token,
      expiresAt: undefined,
      started: false,
    });
    expect(observed.output).toContain('pairing');
    expect(observed.output).not.toContain(token);
    expect(observed.output).not.toContain('undefined');
  });

  it('should mint zero codes when omitted and exactly one when requested', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-setup-t3-'),
    );
    const token = 'setup-t3-requested-pairing';
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: async (_file, args = []) => ({
        stdout: args.includes('/usr/bin/id')
          ? '1000'
          : args.includes('--help')
            ? '--log-level --no-browser'
            : args.includes('pair')
              ? `Token: ${token}\nExpires: 2099-01-01T00:00:00Z\n`
              : '',
        stderr: '',
        exitCode: 0,
      }),
    });
    holdServices(sprite);
    const context: SetupContext = {
      ...workstationOf(sprite),
      options: {},
      input: {
        profile: DISABLED_NETWORK_PROFILE,
        runtimeEnv: {},
        sources: {},
        missing: [],
      },
      profile: DISABLED_NETWORK_PROFILE,
      persistsProfile: false,
      isReleaseChanged: false,
      networkEnrolled: false,
      mutation: { started: false },
    };

    const ordinary = await setupAgent(
      dependencies,
      await context.connection.guest(),
      context,
    );

    expect(ordinary).toEqual({
      service: 'configured',
      pairing: { status: 'not requested' },
    });
    expect(context.mutation.started).toBe(true);
    const calls = vi.mocked(sprite.execFile).mock.calls;
    expect(calls.filter(([, args]) => args?.includes('pair'))).toHaveLength(0);

    context.options = { withPairCode: true };
    context.mutation.started = false;
    const requested = await setupAgent(
      dependencies,
      await context.connection.guest(),
      context,
    );

    expect(requested).toMatchObject({
      pairing: {
        status: 'created',
        expiresAt: '2099-01-01T00:00:00Z',
        token: expect.any(PairingSecret),
      },
    });
    expect(requested.pairing.token?.disclose(true)).toBe(token);
    expect(context.mutation.started).toBe(false);
    expect(calls.filter(([, args]) => args?.includes('pair'))).toHaveLength(1);
  });
});

/**
 * the real wiring whose setup file runner is replaced
 * @param runSetupFile the runner to observe
 * @returns dependencies setup runs on
 */
function withSetupRunner(
  runSetupFile: typeof dependencies.guest.native.runSetupFile,
): typeof dependencies {
  return dependenciesWith({
    guest: {
      ...dependencies.guest,
      native: { ...dependencies.guest.native, runSetupFile },
    },
  });
}

/**
 * builds a setup context over a guest that runs nothing
 * @param options parsed setup flags
 * @param root isolated guest filesystem root
 * @param execute native command response boundary, when the scenario needs one
 * @returns the context and its guest
 */
async function quietSetup(
  options: SetupContext['options'],
  root = tmpdir(),
  execute?: Parameters<typeof createFilesystemSprite>[0]['execute'],
): Promise<{ context: SetupContext; guest: GuestChannel }> {
  const sprite = createFilesystemSprite({
    root,
    execute,
  });
  const context: SetupContext = {
    ...workstationOf(sprite),
    options,
    input: {
      profile: DISABLED_NETWORK_PROFILE,
      runtimeEnv: {},
      sources: {},
      missing: [],
    },
    profile: DISABLED_NETWORK_PROFILE,
    persistsProfile: false,
    isReleaseChanged: false,
    networkEnrolled: false,
    mutation: { started: false },
  };

  return { context, guest: await context.connection.guest() };
}

describe('fn:setupEnvironment', () => {
  it('should write the interactively selected runtime environment and return only its variable names', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-runtime-selection-'),
    );
    const path = join(directory.path, 'runtime.env');
    await writeFile(
      path,
      'PROJECT_MODE=development\nCUSTOM_API_KEY=runtime-private-key\n',
    );
    const { context, guest } = await quietSetup({}, directory.path);
    const observed = await driveInk(
      async (interaction) =>
        setupEnvironment(dependencies, guest, { ...context, interaction }),
      [{ waitFor: 'Runtime env file path', input: [path, '\r'] }],
    );

    expect({
      result: observed.result,
      matchedSteps: observed.matchedSteps,
      started: context.mutation.started,
    }).toEqual({
      result: {
        runtimeEnvironment: {
          status: 'configured',
          names: ['PROJECT_MODE', 'CUSTOM_API_KEY'],
        },
      },
      matchedSteps: 1,
      started: true,
    });
    expect(
      JSON.parse(
        await readFile(join(directory.path, RUNTIME_ENV_PATH), 'utf8'),
      ),
    ).toEqual({
      PROJECT_MODE: 'development',
      CUSTOM_API_KEY: 'runtime-private-key',
    });
    expect(observed.output).not.toContain('runtime-private-key');
  });

  it('should honor explicit noninteractive mode even when a terminal interaction is available', async () => {
    const { context, guest } = await quietSetup({ nonInteractive: true });
    const observed = await driveInk(
      async (interaction) =>
        setupEnvironment(dependencies, guest, { ...context, interaction }),
      [],
    );

    expect({
      result: observed.result,
      output: observed.output,
      started: context.mutation.started,
    }).toEqual({
      result: { runtimeEnvironment: { status: 'skipped' } },
      output: expect.not.stringContaining('Runtime env file path'),
      started: false,
    });
  });

  it('should skip the section without --env-file when it cannot prompt', async () => {
    const { context, guest } = await quietSetup({ nonInteractive: true });

    const result = await setupEnvironment(dependencies, guest, context);

    expect(result).toEqual({ runtimeEnvironment: { status: 'skipped' } });
    expect(context.mutation.started).toBe(false);
  });
});

describe('fn:setupSystem', () => {
  it('should run bytes from the interactively selected setup file', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-system-selection-'),
    );
    const path = join(directory.path, 'setup.sh');
    const bytes = Buffer.from('#!/bin/sh\necho selected-script\n');
    await writeFile(path, bytes);
    const observedPath = join(directory.path, 'executed-script');
    const { context, guest } = await quietSetup({}, directory.path);
    const wired = withSetupRunner(async (_guest, input) =>
      writeFile(observedPath, input),
    );
    const observed = await driveInk(
      async (interaction) =>
        setupSystem(wired, guest, { ...context, interaction }),
      [{ waitFor: 'Setup file path', input: [path, '\r'] }],
    );

    expect({
      result: observed.result,
      matchedSteps: observed.matchedSteps,
      started: context.mutation.started,
      executed: await readFile(observedPath),
    }).toEqual({
      result: { setupFile: 'ran' },
      matchedSteps: 1,
      started: true,
      executed: bytes,
    });
  });

  it('should use the already resolved setup bytes even when the host file has since changed', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-system-prepared-'),
    );
    const path = join(directory.path, 'setup.sh');
    await writeFile(path, '#!/bin/sh\necho changed\n');
    const original = Buffer.from('#!/bin/sh\necho validated\n');
    const observedPath = join(directory.path, 'executed-script');
    const { context, guest } = await quietSetup(
      { setupFile: path },
      directory.path,
    );
    context.input.setupFile = original;

    const result = await setupSystem(
      withSetupRunner(async (_guest, input) => writeFile(observedPath, input)),
      guest,
      context,
    );

    expect({
      result,
      executed: await readFile(observedPath),
      started: context.mutation.started,
    }).toEqual({
      result: { setupFile: 'ran' },
      executed: original,
      started: true,
    });
  });

  it('should skip setup file prompting when explicit noninteractive mode accompanies a terminal', async () => {
    const { context, guest } = await quietSetup({ nonInteractive: true });
    const observed = await driveInk(
      async (interaction) =>
        setupSystem(dependencies, guest, { ...context, interaction }),
      [],
    );

    expect({
      result: observed.result,
      output: observed.output,
      started: context.mutation.started,
    }).toEqual({
      result: { setupFile: 'skipped' },
      output: expect.not.stringContaining('Setup file path'),
      started: false,
    });
  });

  it('should skip the section without a setup file when it cannot prompt', async () => {
    const { context, guest } = await quietSetup({ nonInteractive: true });
    const runSetupFile = vi.fn<typeof dependencies.guest.native.runSetupFile>(
      async () => undefined,
    );

    const result = await setupSystem(
      withSetupRunner(runSetupFile),
      guest,
      context,
    );

    expect({
      result,
      calls: runSetupFile.mock.calls,
      started: context.mutation.started,
    }).toEqual({
      result: { setupFile: 'skipped' },
      calls: [],
      started: false,
    });
  });

  it('should run the selected setup file with its exact bytes', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-setup-system-'),
    );
    const path = join(directory.path, 'setup.sh');
    const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
    await writeFile(path, bytes);
    const { context, guest } = await quietSetup({ setupFile: path });
    const runSetupFile = vi.fn<typeof dependencies.guest.native.runSetupFile>(
      async () => undefined,
    );

    const result = await setupSystem(
      withSetupRunner(runSetupFile),
      guest,
      context,
    );

    expect({
      result,
      calls: runSetupFile.mock.calls,
      started: context.mutation.started,
    }).toEqual({
      result: { setupFile: 'ran' },
      calls: [[guest, bytes]],
      started: true,
    });
  });
});

describe('fn:setupGit', () => {
  it('should name every source of a missing Git identity before changing the guest', async () => {
    vi.stubEnv('GIT_AUTHOR_NAME', undefined);
    vi.stubEnv('GIT_AUTHOR_EMAIL', undefined);
    vi.stubEnv('GIT_COMMITTER_NAME', undefined);
    vi.stubEnv('GIT_COMMITTER_EMAIL', undefined);
    const { context, guest } = await quietSetup({
      nonInteractive: true,
      localCredentials: false,
    });

    await expect(setupGit(dependencies, guest, context)).rejects.toMatchObject({
      code: 'INPUT',
      message: 'Required setup inputs are missing',
      details: [
        'Git author identity is not set. Set GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL or pass --credential-file FILE ' +
          'containing GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL; use --git-name NAME and --git-email EMAIL; ' +
          'or run in a TTY to enter it when prompted. Or pass --no-git-identity to leave it unset.',
      ],
    });
    expect(context.mutation.started).toBe(false);
  });
});

describe('fn:setupGithub', () => {
  it.each([
    { github: false, expected: 'preserved' },
    { github: undefined, expected: 'skipped' },
  ] as const)(
    'should leave guest authentication unchanged when GitHub is $expected',
    async ({ github, expected }) => {
      vi.stubEnv('GH_TOKEN', undefined);
      vi.stubEnv('GITHUB_TOKEN', undefined);
      const { context, guest } = await quietSetup({
        github,
        localCredentials: false,
        nonInteractive: true,
      });

      expect({
        result: await setupGithub(dependencies, guest, context),
        started: context.mutation.started,
      }).toEqual({ result: { github: expected }, started: false });
    },
  );

  it('should configure the selected GitHub host and provider accounts with the resolved credential', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-github-selected-'),
    );
    const credential = join(directory.path, 'github-token');
    const configured = join(directory.path, 'native-authentication');
    await writeFile(credential, 'selected-github-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
        if (url !== 'https://github.example.test/api/v3/user') {
          throw new Error('Unexpected GitHub endpoint');
        }

        return Response.json({ login: 'selected-user' });
      }),
    );
    const { context, guest } = await quietSetup(
      {
        githubTokenSource: `file:${credential}`,
        githubHost: 'github.example.test',
        localCredentials: false,
        nonInteractive: true,
      },
      directory.path,
    );
    const wired = dependenciesWith({
      guest: {
        ...dependencies.guest,
        native: {
          ...dependencies.guest.native,
          configureGithub: async (_guest, secret, target) =>
            writeFile(
              configured,
              JSON.stringify({ token: revealSecret(secret), ...target }),
            ),
        },
      },
    });

    const result = await setupGithub(wired, guest, context);

    expect({
      result,
      started: context.mutation.started,
      native: JSON.parse(await readFile(configured, 'utf8')),
    }).toEqual({
      result: { github: 'configured' },
      started: true,
      native: {
        token: 'selected-github-secret',
        hostname: 'github.example.test',
        shellAccounts: ['sprite'],
      },
    });
  });
});

describe('fn:stopService', () => {
  it('should surface a provider stop failure while the service remains running', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-stop-refused-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const services = holdServices(sprite);
    services.set('agent-service', {
      name: 'agent-service',
      cmd: '/bin/true',
      args: [],
      needs: [],
      state: { name: 'agent-service', status: 'running' },
    });
    const { connection } = workstationOf(sprite);
    const guest = await connection.guest();
    vi.spyOn(guest.services, 'stop').mockResolvedValue(false);

    await expect(stopService(guest, 'agent-service')).rejects.toMatchObject({
      code: 'PROVIDER',
      message: expect.stringContaining('agent-service'),
    });
    expect(services.get('agent-service')?.state?.status).toBe('running');
    await connection.close();
  });
});
