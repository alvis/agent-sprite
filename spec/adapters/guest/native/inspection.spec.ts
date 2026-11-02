import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createNativeInspection } from '#adapters/guest/native/inspection';
import { defaults } from '#composition/defaults';
import { registry } from '#composition/registry';

import { createFilesystemSprite, guestOf } from '../../../mocks/sprites';

import type { DriverRegistry } from '#application/ports/drivers';
import type { HarnessInspection } from '#domain/observations/harness';

const OBSERVATION = {
  configuration: {
    gatewayConfigured: false,
    modelDiscoveryEnabled: false,
    pluginListAvailable: true,
    awakeHooksInstalled: false,
    authentication: 'native',
  },
  selectedPlugins: ['selected-plugin'],
  pluginsEnabled: true,
  evidence: undefined,
} satisfies HarnessInspection;
const DRIVERS = {
  ...registry,
  agents: {
    t3: {
      ...registry.agents.t3,
      inspectEnvironment: vi.fn(async () => undefined),
    },
  },
  harnesses: {
    claude: {
      ...registry.harnesses.claude,
      inspect: vi.fn(async () => OBSERVATION),
    },
    codex: {
      ...registry.harnesses.codex,
      inspect: vi.fn(async () => OBSERVATION),
    },
  },
} satisfies DriverRegistry;
const INSPECTION = createNativeInspection({ registry: DRIVERS, defaults });

describe('fn:createNativeInspection', () => {
  it('should inspect the default harness selection when none is supplied', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'native-inspection-'),
    );
    const guest = guestOf(createFilesystemSprite({ root: directory.path }));
    const inspection = await INSPECTION.inspect(guest);

    expect(inspection.harnesses).toEqual({
      claude: { selectedPlugins: ['selected-plugin'], evidence: undefined },
      codex: { selectedPlugins: ['selected-plugin'], evidence: undefined },
    });
  });
});
