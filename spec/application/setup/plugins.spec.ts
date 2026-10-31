import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { setupPlugins } from '#application/setup/plugins';

import { pluginFlags } from '../../fixtures/plugin-flags';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';
import { dependencies } from '../../mocks/dependencies';
import { createFilesystemSprite, workstationOf } from '../../mocks/sprites';

import type { CommandOptions } from '#application/contracts';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { HostPorts } from '#application/ports/host';
import type { SetupContext } from '#application/setup/context';

const guest =
  {} satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;

describe('fn:setupPlugins', () => {
  it('should reject actions for a harness other than the explicitly selected one', async () => {
    const context = pluginContext(
      pluginFlags({
        pluginHarness: 'claude',
        disableCodexPlugin: ['coding@alvis'],
      }),
    );

    await expect(
      setupPlugins(dependencies, guest, context),
    ).rejects.toMatchObject({
      message: expect.stringContaining('--plugin-harness'),
    });

    expect(context.mutation.started).toBe(false);
  });

  it.each([
    { host: {}, token: 'marketplace-private-token' },
    { host: { githubHost: 'GITHUB.COM' }, token: 'marketplace-private-token' },
    { host: { githubHost: 'github.example.test' }, token: undefined },
  ])(
    'should reject inaccessible marketplaces without leaking credentials for $host',
    async ({ host, token }) => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async () => Response.json({ login: 'test-user' })),
      );
      const classify = vi.fn<HostPorts['marketplaces']['classify']>(
        async ({ source, harness }) => ({
          source,
          harness,
          compatibility: 'inaccessible',
          reason: 'Unavailable source',
        }),
      );
      const wired = {
        ...dependencies,
        host: {
          ...dependencies.host,
          run: vi.fn<HostPorts['run']>(async () => ''),
          environment: {
            ...dependencies.host.environment,
            variables: () => ({ GH_TOKEN: 'marketplace-private-token' }),
          },
          marketplaces: { classify },
        } satisfies HostPorts,
      };
      const context = pluginContext(
        pluginFlags({
          ...host,
          localCredentials: false,
          claudeMarketplace: ['private/source'],
        }),
      );

      await expect(setupPlugins(wired, guest, context)).rejects.toMatchObject({
        code: 'INPUT',
      });

      expect({
        started: context.mutation.started,
        lookups: classify.mock.calls,
      }).toEqual({
        started: false,
        lookups: [
          [
            expect.objectContaining({
              source: 'private/source',
              harness: 'claude',
              accessToken: token,
            }),
          ],
        ],
      });
    },
  );
});

/**
 * supplies setup state for plugin preflight without opening a guest session
 * @param options requested native actions
 * @returns an isolated setup invocation
 */
function pluginContext(options: CommandOptions): SetupContext {
  return {
    ...workstationOf(createFilesystemSprite({ root: tmpdir() })),
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
}
