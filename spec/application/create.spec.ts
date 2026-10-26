import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { SpriteProvider } from '#adapters/drivers/providers/sprite';
import {
  MANAGED_LABEL,
  SCHEMA_LABEL,
  SETUP_INCOMPLETE_LABEL,
  SETUP_READY_LABEL,
} from '#adapters/drivers/providers/sprite/labels';
import { createWorkstation } from '#application/create';
import { OperationContext, withOperation } from '#kernel/operation';
import { ProviderFault } from '#kernel/provider-fault';

import { environmentOf } from '../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile';
import { dependencies, dependenciesWith } from '../mocks/dependencies';
import { standInSession } from '../mocks/session';
import {
  createFilesystemSprite,
  guestOf,
  holdServices,
  serveServiceRegistry,
} from '../mocks/sprites';

import type { CommandRequest } from '#application/contracts';
import type { SetupSession } from '#application/ports/session';
import type { GuestInspection } from '#domain/observations/inspection';

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

const NAME = 'ready-workstation';
const TOKEN = 'workflow-org/1234/0123abcd/4567ef89';

const SERVED = {
  ok: true,
  serverVersion: '0.0.46-nightly.20261014.3118',
  orchestrationProtocolVersion: 2,
} as const;

const OBSERVED = {
  services: [
    { name: 't3-code', needs: [], status: 'running' },
    { name: 'open-agent-cron', needs: [], status: 'running' },
  ],
  network: {
    online: false,
    dnsReady: false,
    skipped: true,
    reason: 'No private network is selected',
  },
  native: {
    claude: {
      gatewayConfigured: false,
      modelDiscoveryEnabled: false,
      pluginListAvailable: false,
      awakeHooksInstalled: true,
      authentication: 'not-configured',
    },
    codex: {
      gatewayConfigured: false,
      modelDiscoveryEnabled: false,
      pluginListAvailable: false,
      awakeHooksInstalled: true,
      authentication: 'not-configured',
    },
    agentEnvironment: SERVED,
    harnesses: {
      claude: {
        selectedPlugins: [],
        evidence: { sdkPluginLoading: 'not-verified' },
      },
      codex: {
        selectedPlugins: [],
        evidence: { sdkPluginLoading: 'not-verified' },
      },
    },
  },
  hub: { skipped: true, reachable: false },
  environment: environmentOf(DISABLED_NETWORK_PROFILE),
  probeFailures: [],
  governor: { recorded: false, reason: 'no awake event has been recorded yet' },
} satisfies GuestInspection;

const REQUEST = {
  command: 'create',
  options: {
    name: NAME,
    provider: 'sprite',
    nonInteractive: true,
    yes: true,
    localCredentials: false,
    github: false,
    plugins: false,
    gitIdentity: false,
    harness: ['claude', 'codex'],
    network: 'none',
    proxy: false,
  },
} satisfies CommandRequest;

describe('fn:createWorkstation', () => {
  it('should create a private workstation and expose it only after ready setup', async () => {
    vi.stubEnv('SPRITES_TOKEN', TOKEN);
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-create-workflow-'),
    );
    const sprite = Object.assign(
      createFilesystemSprite({ root: directory.path, name: NAME }),
      {
        id: 'sprite-ready-workflow',
        organizationName: 'fixture-organization',
        labels: [MANAGED_LABEL, SCHEMA_LABEL],
        url: `https://${NAME}.sprites.app/`,
        urlSettings: { auth: 'sprite' },
        status: 'running',
      },
    );
    holdServices(sprite);
    serveServiceRegistry(sprite);
    const events: string[] = [];
    const channel = guestOf(sprite);
    const rootSession = standInSession(channel);
    const connection = {
      ...rootSession,
      open: async () => rootSession,
      reopen: async () => rootSession,
      lend: async () => rootSession,
      close: async () => undefined,
      guest: async () => channel,
    } satisfies SetupSession;
    const wired = dependenciesWith({
      guest: {
        ...dependencies.guest,
        plan: {
          ...dependencies.guest.plan,
          needsBottleProbe: () => false,
          run: vi.fn(async () => ({ isComplete: true, steps: [] })),
        },
        session: { ...dependencies.guest.session, connect: () => connection },
        native: {
          ...dependencies.guest.native,
          inspectAgentEnvironment: async () => SERVED,
        },
        inspection: {
          ...dependencies.guest.inspection,
          inspect: async () => {
            events.push('inspected');

            return OBSERVED;
          },
        },
        environment: {
          ...dependencies.guest.environment,
          read: async () => environmentOf(DISABLED_NETWORK_PROFILE),
          write: async () => undefined,
        },
      },
    });
    using list = vi
      .spyOn(SpritesClient.prototype, 'listAllSprites')
      .mockImplementation(async () => []);
    using create = vi
      .spyOn(SpritesClient.prototype, 'createSprite')
      .mockImplementation(async () => sprite);
    using visibility = vi
      .spyOn(sprite, 'updateURLSettings')
      .mockImplementation(async (settings) => {
        events.push('exposed');
        Object.assign(sprite.urlSettings, settings);
      });
    vi.spyOn(sprite, 'update').mockImplementation(async (update) => {
      events.push('ready recorded');
      Object.assign(sprite, update);

      return sprite;
    });
    const finishStages: Array<{ event: string; outcome: string | undefined }> =
      [];
    const operation = new OperationContext({
      signal: new AbortController().signal,
      onStage: ({ stage, event, outcome }) => {
        if (stage === 'create.finish' && event === 'complete') {
          finishStages.push({ event, outcome });
        }
      },
    });
    const result = await withOperation(operation, async () =>
      createWorkstation(wired, REQUEST),
    );
    if (!result.ok) {
      throw new Error(`${result.error.code}: ${result.error.message}`);
    }

    expect(result).toMatchObject({
      command: 'create',
      ok: true,
      data: {
        machine: { id: 'sprite-ready-workflow', name: NAME, setup: 'ready' },
        readiness: { ready: true, failures: [] },
      },
    });
    expect(sprite.urlSettings).toMatchObject({ auth: 'public' });
    expect(sprite.labels).toContain(SETUP_READY_LABEL);
    expect(create.mock.calls).toEqual([
      [NAME, expect.objectContaining({ urlSettings: { auth: 'sprite' } })],
    ]);
    expect(list.mock.calls).toEqual([[]]);
    expect(visibility.mock.calls).toEqual([[{ auth: 'public' }]]);
    expect(events).toEqual(['inspected', 'exposed', 'ready recorded']);
    expect(finishStages).toEqual([{ event: 'complete', outcome: 'ok' }]);
  });

  it('should report retained identity after provider creation rejects', async () => {
    vi.stubEnv('SPRITES_TOKEN', TOKEN);
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-create-provider-failure-'),
    );
    const sprite = Object.assign(
      createFilesystemSprite({ root: directory.path, name: NAME }),
      {
        id: 'sprite-retained-after-create',
        organizationName: 'fixture-organization',
        labels: [MANAGED_LABEL, SCHEMA_LABEL],
      },
    );
    vi.spyOn(SpritesClient.prototype, 'listAllSprites').mockImplementation(
      async () => [],
    );
    using create = vi
      .spyOn(SpritesClient.prototype, 'createSprite')
      .mockRejectedValue(new Error('provider create rejected'));
    vi.spyOn(SpritesClient.prototype, 'getSprite').mockImplementation(
      async () => sprite,
    );

    const result = await createWorkstation(dependencies, REQUEST);

    expect({ result, providerCalls: create.mock.calls }).toMatchObject({
      result: {
        command: 'create',
        ok: false,
        error: {
          code: 'PROVIDER',
          outcome: 'retained',
          machine: NAME,
          machineId: 'sprite-retained-after-create',
          setupIncomplete: true,
        },
      },
      providerCalls: [[NAME, expect.anything()]],
    });
  });

  it('should retain a private workstation after guest opening fails', async () => {
    vi.stubEnv('SPRITES_TOKEN', TOKEN);
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-create-guest-failure-'),
    );
    const sprite = Object.assign(
      createFilesystemSprite({ root: directory.path, name: NAME }),
      {
        id: 'sprite-incomplete-workflow',
        organizationName: 'fixture-organization',
        labels: [MANAGED_LABEL, SCHEMA_LABEL],
        url: `https://${NAME}.sprites.app/`,
        urlSettings: { auth: 'sprite' },
        status: 'running',
      },
    );
    const events: string[] = [];
    vi.spyOn(SpritesClient.prototype, 'listAllSprites').mockImplementation(
      async () => [],
    );
    vi.spyOn(SpritesClient.prototype, 'createSprite').mockImplementation(
      async () => sprite,
    );
    vi.spyOn(SpriteProvider.prototype, 'openGuest').mockRejectedValue(
      new ProviderFault({ code: 'failed', message: 'guest opening failed' }),
    );
    vi.spyOn(sprite, 'updateURLSettings').mockImplementation(
      async (settings) => {
        events.push(`visibility:${settings.auth}`);
        Object.assign(sprite.urlSettings, settings);
      },
    );
    vi.spyOn(sprite, 'update').mockImplementation(async (update) => {
      events.push('labels:incomplete');
      Object.assign(sprite, update);

      return sprite;
    });
    const finishStages: Array<{ event: string; outcome: string | undefined }> =
      [];
    const operation = new OperationContext({
      signal: new AbortController().signal,
      onStage: ({ stage, event, outcome }) => {
        if (stage === 'create.finish' && event === 'complete') {
          finishStages.push({ event, outcome });
        }
      },
    });

    const result = await withOperation(operation, async () =>
      createWorkstation(dependencies, REQUEST),
    );

    expect({
      result,
      auth: sprite.urlSettings.auth,
      labels: sprite.labels,
      events,
      finishStages,
    }).toMatchObject({
      result: {
        command: 'create',
        ok: false,
        error: {
          code: 'PROVIDER',
          outcome: 'retained',
          machine: NAME,
          machineId: 'sprite-incomplete-workflow',
          setupIncomplete: true,
        },
        data: {
          recovery: { privacy: 'confirmed', incompleteLabel: 'confirmed' },
        },
      },
      auth: 'sprite',
      labels: expect.arrayContaining([MANAGED_LABEL, SETUP_INCOMPLETE_LABEL]),
      events: ['visibility:sprite', 'labels:incomplete'],
      finishStages: [{ event: 'complete', outcome: 'failed' }],
    });
  });
});
