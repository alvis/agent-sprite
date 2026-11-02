import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { recordSetupMetadata } from '#application/setup/metadata';
import { summarizeProfile } from '#domain/recorded';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';
import { createFilesystemSprite, workstationOf } from '../../mocks/sprites';

import type { ProviderDriver } from '#application/ports/drivers';
import type { SetupContext } from '#application/setup/context';

describe('fn:recordSetupMetadata', () => {
  it.each([
    { section: 'all', setup: 'ready' },
    { section: 'tools', setup: 'incomplete' },
  ] as const)(
    'should record the current version after $section setup',
    async ({ section, setup }) => {
      const selected = workstationOf(
        createFilesystemSprite({ root: tmpdir() }),
      );
      const workstation = {
        ...selected.workstation,
        metadata: {
          ...selected.workstation.metadata,
          setup: 'incomplete',
          version: 'older-release',
        },
      } satisfies SetupContext['workstation'];
      const provider = {
        setMetadata: vi.fn<ProviderDriver['setMetadata']>(
          async (record, metadata) => ({
            ...record,
            metadata: { ...record.metadata, ...metadata },
          }),
        ),
      } satisfies Partial<ProviderDriver>;
      const context: SetupContext = {
        ...selected,
        workstation,
        provider: provider as Partial<ProviderDriver> as ProviderDriver,
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

      const result = await recordSetupMetadata(section, context);

      expect(result).toEqual({
        ...workstation,
        metadata: {
          ...workstation.metadata,
          setup,
          profile: summarizeProfile(DISABLED_NETWORK_PROFILE),
          version: OPEN_AGENT_VERSION,
        },
      });
    },
  );
});
