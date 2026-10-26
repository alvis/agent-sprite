import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createGuestMechanics } from '#adapters/guest/mechanics';
import { RUNTIME_ENV_PATH, accountHome } from '#adapters/guest/platform/layout';
import { defaults } from '#composition/defaults';
import { registry } from '#composition/registry';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';
import {
  createFilesystemSprite,
  guestOf,
  sessionGuestOf,
} from '../../mocks/sprites';

import type { OsRelease } from '#domain/guest';
import type { WorkstationRecord } from '#domain/workstation';

vi.mock(
  '#adapters/guest/platform/session/open',
  () =>
    ({
      openWorkstationSession: vi.fn<
        typeof import('#adapters/guest/platform/session/open').openWorkstationSession
      >(async () => ({
        release: {
          family: 'debian',
          id: 'debian',
          versionId: '12',
          codename: 'bookworm',
          arch: 'x86_64',
          libc: 'glibc',
        },
        pid: 42,
        run: async ({ argv }) => ({
          exitCode: 0,
          stdout: argv.join(' ').includes('nightly')
            ? 'installed=1.0.0\ntagged=2.0.0\n'
            : 'installed=1.0.0\ntagged=1.5.0\n',
          stderr: '',
        }),
        [Symbol.asyncDispose]: async () => undefined,
      })),
    }) satisfies Partial<
      typeof import('#adapters/guest/platform/session/open')
    >,
);

const RELEASE: OsRelease = {
  family: 'debian',
  id: 'debian',
  versionId: '12',
  codename: 'bookworm',
  arch: 'x86_64',
  libc: 'glibc',
};

const WORKSTATION = {
  id: 'test',
  name: 'test',
  organization: 'test',
  state: 'running',
  metadata: { setup: 'incomplete' },
} satisfies WorkstationRecord;

const PROFILE = {
  ...DISABLED_NETWORK_PROFILE,
  options: { ...DISABLED_NETWORK_PROFILE.options, agentRelease: 'nightly' },
};

describe('fn:createGuestMechanics', () => {
  it('should assemble a setup plan for the selected agent channel and guest release', async () => {
    const mechanics = createGuestMechanics({ registry, defaults });

    const assembly = await mechanics.plan.assemble({
      provider: registry.providers['fly-machine'],
      profile: PROFILE,
      release: RELEASE,
      version: OPEN_AGENT_VERSION,
      setupAt: '2026-10-26T00:00:00Z',
    });

    expect(assembly).toEqual(
      expect.objectContaining({
        environment: expect.objectContaining({
          profile: PROFILE,
          setup: { state: 'incomplete', skipped: [] },
          agent: expect.objectContaining({ id: PROFILE.agent }),
        }),
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: 'environment',
            component: 'environment',
          }),
        ]),
      }),
    );
  });

  it('should read installed and channel releases through the connected guest session', async () => {
    const mechanics = createGuestMechanics({ registry, defaults });
    await using connection = mechanics.session.connect({
      provider: registry.providers['fly-machine'],
      workstation: WORKSTATION,
    });

    await expect(
      mechanics.tools.inspectAgentRelease(connection, PROFILE),
    ).resolves.toEqual({
      status: 'known',
      installed: '1.0.0',
      tagged: '2.0.0',
    });
  });

  it('should inspect the selected agent environment through its guest probe', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-mechanics-'),
    );
    const guest = guestOf(
      createFilesystemSprite({
        root: directory.path,
        execute: async () => ({
          exitCode: 0,
          stdout: '{"serverVersion":"2.3.4","label":"test-workstation"}\n200',
          stderr: '',
        }),
      }),
    );
    const mechanics = createGuestMechanics({ registry, defaults });

    await expect(
      mechanics.native.inspectAgentEnvironment(guest),
    ).resolves.toEqual({
      ok: true,
      serverVersion: '2.3.4',
      label: 'test-workstation',
    });
  });

  it('should configure approved runtime variables for the agent and provider shell', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-mechanics-env-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const mechanics = createGuestMechanics({ registry, defaults });
    const variables = { APP_MODE: 'runtime-probe-mode' };

    await mechanics.native.configureRuntimeEnv(
      sessionGuestOf(sprite),
      variables,
      ['sprite'],
    );

    expect({
      runtime: JSON.parse(
        await readFile(join(directory.path, RUNTIME_ENV_PATH), 'utf8'),
      ),
      providerShell: await readFile(
        join(
          directory.path,
          accountHome('sprite'),
          '.config/open-agent/env.sh',
        ),
        'utf8',
      ).catch(() => undefined),
    }).toEqual({
      runtime: variables,
      providerShell: expect.stringContaining(
        `export APP_MODE='${variables.APP_MODE}'`,
      ),
    });
  });
});
