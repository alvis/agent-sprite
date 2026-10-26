import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import {
  MANAGED_LABEL,
  mergeMetadataLabels,
  SCHEMA_LABEL,
} from '#adapters/drivers/providers/sprite/labels';
import { ENVIRONMENT_PATH } from '#adapters/guest/platform/layout';
import { setupWorkstation } from '#application/setup';
import { registry } from '#composition/registry';
import { summarizeProfile } from '#domain/recorded';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { environmentOf } from '../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile';
import { dependencies, dependenciesWith } from '../mocks/dependencies';
import {
  createFilesystemSprite,
  holdServices,
  providerOf,
} from '../mocks/sprites';

import type { Sprite } from '@fly/sprites';

import type { Interaction } from '#application/ports/interaction';

// A setup section's root session is the framed guest shell represented by the stand-in.
vi.mock(
  '#adapters/guest/platform/session/open',
  async () => import('../mocks/session'),
);
// The native Codex app server owns hook trust; this test exercises setup around it.
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

/**
 * a managed workstation with a ready guest record for section behavior
 * @param root temporary guest filesystem root
 * @returns its sprite and provider control
 */
async function managedWorkstation(root: string): Promise<{
  sprite: Sprite;
  provider: ReturnType<typeof providerOf>;
}> {
  const sprite = Object.assign(
    createFilesystemSprite({
      root,
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    {
      id: 'sprite-setup-sections',
      organizationName: 'test',
      labels: mergeMetadataLabels([MANAGED_LABEL, SCHEMA_LABEL], {
        setup: 'ready',
        profile: summarizeProfile(DISABLED_NETWORK_PROFILE),
        version: OPEN_AGENT_VERSION,
      }),
    },
  );
  const client = new SpritesClient('test-token');
  Object.assign(client, {
    getSprite: vi.fn<SpritesClient['getSprite']>(async () => sprite),
  });
  vi.spyOn(sprite, 'update').mockImplementation(async (options) =>
    Object.assign(sprite, options),
  );
  vi.spyOn(sprite, 'updateURLSettings').mockResolvedValue(undefined);
  const agentName =
    registry.agents[DISABLED_NETWORK_PROFILE.agent].service.name;
  holdServices(sprite).set(agentName, {
    name: agentName,
    cmd: '/bin/true',
    args: [],
    needs: [],
    state: { name: agentName, status: 'running' },
  });
  await sprite
    .filesystem()
    .writeFile(
      ENVIRONMENT_PATH,
      JSON.stringify(environmentOf(DISABLED_NETWORK_PROFILE)),
    );

  return { sprite, provider: providerOf(client) };
}

describe('fn:setupWorkstation', () => {
  it('should return a machine-free unchanged result when a shared network credential is declined', async () => {
    const provider = registry.providers.sprite;
    const prompts: string[] = [];
    const interaction: Interaction = {
      input: async () => {
        throw new Error('No text input was requested');
      },
      secret: async () => {
        throw new Error('A declined replacement must not ask for a key');
      },
      select: async (prompt, choices) => {
        prompts.push(prompt.message);
        const selected = choices.find(
          ({ value }) =>
            value ===
            (prompt.message === 'Choose setup section'
              ? 'network'
              : 'network-credential'),
        );
        if (!selected) {
          throw new Error(`No supported ${prompt.message} choice was offered`);
        }

        return selected.value;
      },
      multiselect: async () => [],
      confirm: async () => false,
      progress: () => undefined,
      status: () => undefined,
    };

    await expect(
      setupWorkstation(dependencies, {
        request: { command: 'setup', options: {} },
        provider,
        interaction,
      }),
    ).resolves.toEqual({
      command: 'setup',
      ok: true,
      data: {
        localCredential: {
          status: 'unchanged',
          scope: 'this computer; all workstations',
        },
      },
    });
    expect(prompts).toEqual(['Choose setup section', 'Network']);
  });

  it.each([
    {
      section: 'network',
      outcome: { network: { status: 'disabled', readiness: 'skipped' } },
    },
    { section: 'github', outcome: { github: 'preserved' } },
    { section: 'git', outcome: { gitIdentity: 'preserved' } },
    { section: 'proxy', outcome: { proxy: { status: 'disabled' } } },
    { section: 'env', outcome: { runtimeEnvironment: { status: 'skipped' } } },
    { section: 'system', outcome: { setupFile: 'skipped' } },
    {
      section: 'plugins',
      outcome: { plugins: { claude: 'preserved', codex: 'preserved' } },
    },
  ] as const)(
    'should return the selected $section outcome for a managed workstation',
    async ({ section, outcome }) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-selected-setup-'),
      );
      const { sprite, provider } = await managedWorkstation(directory.path);

      const result = await setupWorkstation(dependencies, {
        request: {
          command: 'setup',
          machine: sprite.name,
          options: {
            section,
            nonInteractive: true,
            localCredentials: false,
            github: false,
            gitIdentity: false,
            plugins: false,
            ...(section === 'proxy' && { proxy: false }),
            ...(section === 'network' && { network: 'none' as const }),
          },
        },
        provider,
      });

      expect(result).toMatchObject({
        command: 'setup',
        ok: true,
        data: { section, ...outcome },
      });
    },
  );

  it('should retain an incomplete setup after the selected full plan fails', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-selected-all-'),
    );
    const { sprite, provider } = await managedWorkstation(directory.path);
    const run = vi.fn<typeof dependencies.guest.plan.run>(async () => {
      throw new Error('plan refused');
    });
    const guest = {
      ...dependencies.guest,
      plan: { ...dependencies.guest.plan, run },
    };

    const result = await setupWorkstation(dependenciesWith({ guest }), {
      request: {
        command: 'setup',
        machine: sprite.name,
        options: {
          section: 'all',
          network: 'none',
          nonInteractive: true,
          localCredentials: false,
          github: false,
          gitIdentity: false,
          plugins: false,
        },
      },
      provider,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      command: 'setup',
      ok: false,
      error: {
        message: expect.stringContaining('plan refused'),
        setupIncomplete: true,
      },
    });
    expect(vi.mocked(sprite.updateURLSettings)).not.toHaveBeenCalled();
  });
});
