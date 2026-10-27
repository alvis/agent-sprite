import { PassThrough } from 'node:stream';

import { Sprite, SpritesClient } from '@fly/sprites';

import { describe, expect, it, vi } from 'vitest';

import {
  MANAGED_LABEL,
  SCHEMA_LABEL,
  SETUP_INCOMPLETE_LABEL,
  SETUP_READY_LABEL,
} from '#adapters/drivers/providers/sprite/labels';

import { toRecord } from '#adapters/drivers/providers/sprite/records';

import { configureNewWorkstation } from '#application/create/configuration';

import { markCreateIncomplete } from '#application/create/failure';

import { finalizeCreate, finishCreate } from '#application/create/finalization';

import {
  normalizePluginOptions,
  resolvePluginActions,
} from '#application/plugins';

import { inspectUntilServing } from '#application/serving';

import { resultExitCode } from '#cli/exit';

import { prepareResult, writePreparedResult } from '#cli/output';

import { registry } from '#composition/registry';

import { CommandFault } from '#kernel/faults';

import { OperationContext, withOperation } from '#kernel/operation';

import { rememberSecret } from '#kernel/redaction';

import { environmentOf } from '../../fixtures/environment';

import {
  DISABLED_NETWORK_PROFILE,
  TAILSCALE_PROFILE,
} from '../../fixtures/profile';

import { dependencies, dependenciesWith } from '../../mocks/dependencies';

import { guestOf, providerOf } from '../../mocks/sprites';

import type { CommandOptions } from '#application/contracts';

import type { CreateContext } from '#application/create/context';

import type { GuestChannel } from '#application/ports/guest-channel';

import type { Interaction } from '#application/ports/interaction';

import type { SetupSession } from '#application/ports/session';

import type { CommandResult } from '#application/result';

import type { GuestInspection } from '#domain/observations/inspection';

import type { WorkstationRecord } from '#domain/workstation';

vi.mock(
  '#application/create/configuration',
  async (importOriginal) =>
    ({
      ...(await importOriginal<
        typeof import('#application/create/configuration')
      >()),
      configureNewWorkstation:
        vi.fn<
          typeof import('#application/create/configuration').configureNewWorkstation
        >(),
    }) satisfies Partial<typeof import('#application/create/configuration')>,
);

vi.mock(
  '#application/serving',
  async (importOriginal) =>
    ({
      ...(await importOriginal<typeof import('#application/serving')>()),
      inspectUntilServing:
        vi.fn<typeof import('#application/serving').inspectUntilServing>(),
    }) satisfies Partial<typeof import('#application/serving')>,
);

const WORKSTATION = {
  id: 'workstation-1',
  name: 'primary',
  organization: 'test',
  state: 'running',
  url: 'https://primary.example.test/',
  metadata: { setup: 'incomplete' },
} satisfies WorkstationRecord;

const CONTEXT = {
  options: {},
  input: {
    name: WORKSTATION.name,
    providerToken: 'test-token',
    profile: DISABLED_NETWORK_PROFILE,
    runtimeEnv: {},
    sources: {},
    missing: [],
  },
  name: WORKSTATION.name,
  token: 'test-token',
  plugins: resolvePluginActions(normalizePluginOptions({})),
  preflight: { checks: [], reminders: [] },
  provider: registry.providers.sprite,
} satisfies CreateContext;

const CHANNEL = {
  exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
} satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;

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
    agentEnvironment: {
      ok: true,
      serverVersion: '0.0.46-nightly.20261014.3118',
      orchestrationProtocolVersion: 2,
    },
    harnesses: {
      claude: {
        selectedPlugins: [],
        evidence: { sdkPluginLoading: 'not-verified' },
      },
      codex: { selectedPlugins: [], evidence: undefined },
    },
  },
  hub: { skipped: true, reachable: false },
  environment: environmentOf(DISABLED_NETWORK_PROFILE),
  probeFailures: [],
  governor: { recorded: false, reason: 'no awake event has been recorded yet' },
} satisfies GuestInspection;

const services = ['t3-code', 'open-agent-cron'].map((name) => ({
  name,
  needs: [],
  status: 'running' as const,
}));

const observed = {
  services,
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
    agentEnvironment: {
      ok: true,
      serverVersion: '0.0.46-nightly.20261014.3118',
      orchestrationProtocolVersion: 2,
    },
    harnesses: {
      claude: {
        selectedPlugins: [],
        evidence: { sdkPluginLoading: 'not-verified' },
      },
      codex: {
        selectedPlugins: [],
        evidence: undefined,
      },
    },
  },
  hub: { skipped: true, reachable: false },
  environment: environmentOf(DISABLED_NETWORK_PROFILE),
  probeFailures: [],
  governor: { recorded: false, reason: 'no awake event has been recorded yet' },
} satisfies GuestInspection;

/**
 * provides one identified SDK Sprite with real finalization and controlled SDK writes
 * @returns Sprite and ordered provider mutation observations
 */
function createSprite() {
  const client = new SpritesClient('cor04-generated-sdk-token');
  const sprite: Sprite = Object.assign(
    new Sprite('ready-workstation', client),
    {
      id: 'sprite-ready-42',
      organizationName: 'fixture-organization',
      labels: [MANAGED_LABEL, SCHEMA_LABEL],
      url: 'https://ready-workstation.sprites.app/',
      urlSettings: { auth: 'sprite' },
      status: 'running',
    },
  );
  vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);
  const mutations: string[] = [];
  const visibility = vi
    .spyOn(sprite, 'updateURLSettings')
    .mockImplementation(async (settings) => {
      mutations.push(`visibility:${settings.auth}`);
      sprite.urlSettings = settings;
    });
  const labels = vi
    .spyOn(sprite, 'update')
    .mockImplementation(async (update) => {
      mutations.push(
        update.labels?.includes(SETUP_READY_LABEL)
          ? 'labels:ready'
          : 'labels:incomplete',
      );
      Object.assign(sprite, update);

      return sprite;
    });

  return { sprite, mutations, visibility, labels };
}

/**
 * supplies verified create inputs without invoking preflight or an installer
 * @param sprite SDK Sprite selected for finalization
 * @param options optional pairing and disclosure controls
 * @returns complete create context consumed by the real helper
 */
function createContext(
  sprite: Sprite,
  options: CommandOptions = {},
): CreateContext {
  return {
    options,
    input: {
      name: sprite.name,
      providerToken: 'cor04-generated-sdk-token',
      profile: DISABLED_NETWORK_PROFILE,
      runtimeEnv: {},
      sources: {},
      missing: [],
    },
    name: sprite.name,
    token: 'cor04-generated-sdk-token',
    plugins: resolvePluginActions(normalizePluginOptions({})),
    preflight: { checks: ['provider name was available'], reminders: [] },
    provider: providerOf(sprite.client),
  };
}

/**
 * captures both real output destinations for a completed domain result
 * @param result create result from a real finalization or recovery helper
 * @param options human or JSON disclosure controls
 * @returns exact stdout and stderr writes
 */
function captureResult(
  result: CommandResult,
  options: CommandOptions,
): { stdout: string; stderr: string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let errorOutput = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  stderr.on('data', (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });
  try {
    writePreparedResult(
      prepareResult({
        result,
        options,
        streams: { stdout, stderr },
      }),
      { stdout, stderr },
    );
  } finally {
    stdout.destroy();
    stderr.destroy();
  }

  return { stdout: out, stderr: errorOutput };
}

describe('fn:finalizeCreate READY boundary', () => {
  it('should keep READY and returns success when optional native pairing fails', async () => {
    const { sprite, mutations } = createSprite();
    const secret = 'cor04-generated-pairing-secret';
    rememberSecret(secret);
    vi.spyOn(sprite, 'execFile').mockRejectedValue(
      new Error(`pairing rejected ${secret}`),
    );

    const result = await finalizeCreate(dependencies, {
      workstation: toRecord(sprite),
      guest: guestOf(sprite),
      observed,
      context: createContext(sprite, { withPairCode: true }),
    });

    expect(result).toMatchObject({
      command: 'create',
      ok: true,
      data: {
        machine: {
          id: 'sprite-ready-42',
          setup: 'ready',
          agentUrl: 'https://ready-workstation.sprites.app/',
        },
        readiness: { ready: true },
        pairing: {
          status: 'failed',
          retry: 'open-agent show "ready-workstation" --with-pair-code',
        },
      },
    });
    expect(resultExitCode(result)).toBe(0);
    expect(mutations).toEqual(['visibility:public', 'labels:ready']);
    expect(sprite.labels).toContain(SETUP_READY_LABEL);
    expect(sprite.labels).not.toContain(SETUP_INCOMPLETE_LABEL);
    const human = captureResult(result, {});
    const json = captureResult(result, { json: true });
    expect(human.stderr).toBe('');
    expect(human.stdout).toContain('https://ready-workstation.sprites.app/');
    expect(human.stdout).toContain('--with-pair-code');
    expect(human.stdout).toContain('[REDACTED]');
    expect(json.stderr).toBe('');
    expect(json.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'create',
      ok: true,
      data: { pairing: { status: 'failed' } },
    });
    expect(`${human.stdout}${json.stdout}`).not.toContain(secret);
  });

  it('should keep cancellation and retained READY identity when pairing is interrupted', async () => {
    const { sprite, mutations } = createSprite();
    const controller = new AbortController();
    const operation = new OperationContext({ signal: controller.signal });
    operation.identify({ name: sprite.name, id: sprite.id });
    const exec = vi.spyOn(sprite, 'execFile').mockImplementation(
      async () =>
        new Promise<never>(() => {
          // Cancellation is observed by runOperation around this SDK call.
        }),
    );
    const pending = withOperation(operation, async () =>
      finalizeCreate(dependencies, {
        workstation: toRecord(sprite),
        guest: guestOf(sprite),
        observed,
        context: createContext(sprite, { withPairCode: true }),
      }),
    );
    await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce());
    controller.abort();

    const result = await pending;
    expect(result).toMatchObject({
      command: 'create',
      ok: false,
      error: {
        code: 'CANCELLED',
        outcome: 'retained',
        machine: sprite.name,
        machineId: sprite.id,
      },
      data: { setup: 'ready', readiness: { ready: true } },
    });
    expect(resultExitCode(result)).toBe(130);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.setupIncomplete).toBeUndefined();
    }
    expect(mutations).toEqual(['visibility:public', 'labels:ready']);
    expect(sprite.labels).not.toContain(SETUP_INCOMPLETE_LABEL);
    const human = captureResult(result, {});
    const json = captureResult(result, { json: true });
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('Workstation ID: sprite-ready-42');
    expect(json.stderr).toBe('');
    expect(json.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: 'CANCELLED', machineId: 'sprite-ready-42' },
      data: { setup: 'ready' },
    });
  });

  it('should keep native pairing disclosure behind structural consent', async () => {
    const token = 'cor04-generated-native-pair-code';
    const ordinary = createSprite();
    const ordinaryPair = vi
      .spyOn(ordinary.sprite, 'execFile')
      .mockResolvedValue({
        stdout: `Token: ${token}\nExpires: in five minutes\n`,
        stderr: '',
        exitCode: 0,
      });
    const ordinaryResult = await finalizeCreate(dependencies, {
      workstation: toRecord(ordinary.sprite),
      guest: guestOf(ordinary.sprite),
      observed,
      context: createContext(ordinary.sprite),
    });
    const ordinaryOutput = captureResult(ordinaryResult, { json: true });
    expect(ordinaryPair).not.toHaveBeenCalled();
    expect(ordinaryResult).toMatchObject({
      data: { pairing: { status: 'not requested' } },
    });
    expect(ordinaryOutput.stdout).not.toContain(token);
    expect(JSON.parse(ordinaryOutput.stdout).data.machine.agentUrl).toBe(
      'https://ready-workstation.sprites.app/',
    );

    const permitted = createSprite();
    const requestedPair = vi
      .spyOn(permitted.sprite, 'execFile')
      .mockResolvedValue({
        stdout: `Token: ${token}\nExpires: in five minutes\n`,
        stderr: '',
        exitCode: 0,
      });
    const permittedResult = await finalizeCreate(dependencies, {
      workstation: toRecord(permitted.sprite),
      guest: guestOf(permitted.sprite),
      observed,
      context: createContext(permitted.sprite, { withPairCode: true }),
    });
    const permittedOutput = captureResult(permittedResult, {
      json: true,
      withPairCode: true,
    });
    expect(requestedPair).toHaveBeenCalledOnce();
    expect(JSON.parse(permittedOutput.stdout).data).toMatchObject({
      machine: {
        agentUrl: `https://ready-workstation.sprites.app/#token=${token}`,
      },
      pairing: { status: 'created', token },
    });
    expect(permittedOutput.stdout.trim().split('\n')).toHaveLength(1);
    expect(permittedOutput.stderr).toBe('');
  });

  it('should not mint pairing by default after READY', async () => {
    const { sprite, mutations } = createSprite();
    const pair = vi
      .spyOn(sprite, 'execFile')
      .mockRejectedValue(new Error('unexpected native pairing'));

    const result = await finalizeCreate(dependencies, {
      workstation: toRecord(sprite),
      guest: guestOf(sprite),
      observed,
      context: createContext(sprite),
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        machine: { setup: 'ready' },
        pairing: { status: 'not requested' },
      },
    });
    expect(pair).not.toHaveBeenCalled();
    expect(mutations).toEqual(['visibility:public', 'labels:ready']);
  });

  it('should explain empty pairing diagnostics without demoting READY', async () => {
    const { sprite, mutations } = createSprite();
    vi.spyOn(sprite, 'execFile').mockRejectedValue(new Error(''));

    const result = await finalizeCreate(dependencies, {
      workstation: toRecord(sprite),
      guest: guestOf(sprite),
      observed,
      context: createContext(sprite, { withPairCode: true }),
    });

    expect({ result, mutations }).toMatchObject({
      result: {
        command: 'create',
        ok: true,
        data: {
          machine: { id: sprite.id, setup: 'ready' },
          pairing: {
            status: 'failed',
            reason: expect.stringContaining('pairing'),
          },
        },
      },
      mutations: ['visibility:public', 'labels:ready'],
    });
  });

  it('should retain READY when completion progress is cancelled', async () => {
    const { sprite, mutations } = createSprite();
    const controller = new AbortController();
    const operation = new OperationContext({ signal: controller.signal });
    const unexpected = async (): Promise<never> => {
      throw new Error('Completion unexpectedly requested a prompt');
    };
    const interaction = {
      input: unexpected,
      secret: unexpected,
      select: unexpected,
      multiselect: unexpected,
      confirm: unexpected,
      progress: ({ stage }) => {
        if (stage === 'complete') {
          controller.abort();
        }
      },
      status: () => undefined,
    } satisfies Interaction;

    const result = await withOperation(operation, async () =>
      finalizeCreate(dependencies, {
        workstation: toRecord(sprite),
        guest: guestOf(sprite),
        observed,
        context: createContext(sprite),
        interaction,
      }),
    );

    expect({ result, status: resultExitCode(result), mutations }).toMatchObject(
      {
        result: {
          command: 'create',
          ok: false,
          error: {
            code: 'CANCELLED',
            outcome: 'retained',
            machine: sprite.name,
            machineId: sprite.id,
          },
          data: { setup: 'ready', readiness: { ready: true } },
        },
        status: 130,
        mutations: ['visibility:public', 'labels:ready'],
      },
    );
  });

  it('should withhold exposure when the selected exit node changed', async () => {
    const { sprite, mutations } = createSprite();
    const profile = {
      ...TAILSCALE_PROFILE,
      options: {
        ...TAILSCALE_PROFILE.options,
        isExitNodeEnabled: true,
      },
    };
    const base = createContext(sprite);
    const context = {
      ...base,
      effectiveExitNode: 'selected-node',
      input: { ...base.input, profile },
    } satisfies CreateContext;
    const tailscale = registry.networks.tailscale;
    if (!tailscale.daemon || !tailscale.launcher) {
      throw new Error('The selected network lacks its daemon');
    }
    const inspection = {
      ...observed,
      services: [
        ...observed.services,
        { name: tailscale.daemon.name, needs: [], status: 'running' },
      ],
      environment: environmentOf(profile, {
        services: [registry.agents[profile.agent].service, tailscale.daemon],
        network: {
          id: 'tailscale',
          daemon: tailscale.daemon.name,
          launcher: {
            stateDirectory: tailscale.launcher.stateDirectory,
            socket: tailscale.launcher.socket,
            tun: tailscale.launcher.tun,
          },
        },
      }),
      network: {
        online: true,
        skipped: false,
        dnsReady: true,
        routeDevice: 'tailscale0',
        egressIp: '198.51.100.20',
        exitNodeIp: '198.51.100.21',
        exitNodeName: 'different-node',
      },
    } satisfies GuestInspection;

    const failure: unknown = await finalizeCreate(dependencies, {
      workstation: toRecord(sprite),
      guest: guestOf(sprite),
      observed: inspection,
      context,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect({ failure, mutations }).toEqual({
      failure: expect.objectContaining({
        code: 'PREFLIGHT',
        readiness: expect.objectContaining({
          failures: expect.arrayContaining(['selected exit node']),
        }),
      }),
      mutations: [],
    });
  });

  it('should withhold exposure for a served version mismatch', async () => {
    const { sprite, mutations } = createSprite();
    const [agentTool] = registry.agents[DISABLED_NETWORK_PROFILE.agent].tools;
    if (!agentTool) {
      throw new Error('The selected agent has no installable tool');
    }
    const inspection = {
      ...observed,
      environment: environmentOf(DISABLED_NETWORK_PROFILE, {
        tools: [
          {
            name: agentTool.name,
            required: agentTool.required,
            account: 'agent',
            executables: agentTool.executables,
            source: agentTool.sources[0],
            version: 'older-installed-version',
          },
        ],
      }),
    } satisfies GuestInspection;

    const failure: unknown = await finalizeCreate(dependencies, {
      workstation: toRecord(sprite),
      guest: guestOf(sprite),
      observed: inspection,
      context: createContext(sprite),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect({ failure, mutations }).toEqual({
      failure: expect.objectContaining({
        code: 'PREFLIGHT',
        readiness: expect.objectContaining({
          failures: expect.arrayContaining([
            expect.stringContaining('older-installed-version'),
          ]),
        }),
      }),
      mutations: [],
    });
  });

  it.each([
    {
      stage: 'missing URL',
      prepare: 'url',
      message: 'Workstation ready-workstation has no provider URL',
      code: 'PROVIDER',
      beforeRecovery: [],
    },
    {
      stage: 'public exposure rejection',
      prepare: 'public',
      message: 'public exposure rejected',
      code: 'UNEXPECTED',
      beforeRecovery: ['visibility:public'],
    },
    {
      stage: 'READY label rejection',
      prepare: 'ready',
      message: 'READY label rejected',
      code: 'UNEXPECTED',
      beforeRecovery: ['visibility:public', 'labels:ready'],
    },
  ] as const)(
    'should recover $stage before optional pairing starts',
    async ({ prepare, message, code, beforeRecovery }) => {
      const { sprite, mutations, visibility, labels } = createSprite();
      const pair = vi
        .spyOn(sprite, 'execFile')
        .mockRejectedValue(new Error('unexpected native pairing'));
      if (prepare === 'url') {
        sprite.url = '';
      }
      if (prepare === 'public') {
        visibility.mockImplementation(async (settings) => {
          mutations.push(`visibility:${settings.auth}`);
          if (settings.auth === 'public') {
            throw new Error(message);
          }
          sprite.urlSettings = settings;
        });
      }
      if (prepare === 'ready') {
        labels.mockImplementation(async (update) => {
          const ready = update.labels?.includes(SETUP_READY_LABEL) === true;
          mutations.push(ready ? 'labels:ready' : 'labels:incomplete');
          if (ready) {
            throw new Error(message);
          }
          Object.assign(sprite, update);

          return sprite;
        });
      }
      const context = createContext(sprite);
      const failure: unknown = await finalizeCreate(dependencies, {
        workstation: toRecord(sprite),
        guest: guestOf(sprite),
        observed,
        context,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toEqual(
        prepare === 'url'
          ? expect.objectContaining({
              name: 'CommandFault',
              code: 'PROVIDER',
              message,
            })
          : new Error(message),
      );
      expect(mutations).toEqual(beforeRecovery);

      const result = await markCreateIncomplete(dependencies, {
        workstation: toRecord(sprite),
        context,
        error: failure,
      });

      expect(pair).not.toHaveBeenCalled();
      expect(mutations).toEqual([
        ...beforeRecovery,
        'visibility:sprite',
        'labels:incomplete',
      ]);
      expect(sprite.urlSettings?.auth).toBe('sprite');
      expect(sprite.labels).toContain(SETUP_INCOMPLETE_LABEL);
      expect(sprite.labels).not.toContain(SETUP_READY_LABEL);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code,
          message,
          machine: sprite.name,
          machineId: sprite.id,
          setupIncomplete: true,
        },
        data: {
          recovery: { privacy: 'confirmed', incompleteLabel: 'confirmed' },
        },
      });
    },
  );
});

describe('fn:markCreateIncomplete pre-READY recovery', () => {
  it.each([
    {
      privacyFails: false,
      labelFails: false,
      privacy: 'confirmed',
      label: 'confirmed',
    },
    {
      privacyFails: true,
      labelFails: false,
      privacy: 'unconfirmed',
      label: 'confirmed',
    },
    {
      privacyFails: false,
      labelFails: true,
      privacy: 'confirmed',
      label: 'unconfirmed',
    },
    {
      privacyFails: true,
      labelFails: true,
      privacy: 'unconfirmed',
      label: 'unconfirmed',
    },
  ] as const)(
    'should report privacy=$privacy and label=$label independently',
    async ({ privacyFails, labelFails, privacy, label }) => {
      const fixture = createSprite();
      const { sprite, mutations, visibility, labels } = fixture;
      sprite.urlSettings = { auth: 'public' };
      visibility.mockImplementation(async (settings) => {
        mutations.push(`visibility:${settings.auth}`);
        if (privacyFails) {
          throw new Error('privacy update unavailable');
        }
        sprite.urlSettings = settings;
      });
      labels.mockImplementation(async (update) => {
        mutations.push('labels:incomplete');
        if (labelFails) {
          throw new Error('label update unavailable');
        }
        Object.assign(sprite, update);

        return sprite;
      });
      const primary = new CommandFault({
        code: 'PREFLIGHT',
        message: 'original readiness failure',
      });

      const result = await markCreateIncomplete(dependencies, {
        workstation: toRecord(sprite),
        context: createContext(sprite),
        error: primary,
      });

      expect(mutations).toEqual(['visibility:sprite', 'labels:incomplete']);
      expect(result).toMatchObject({
        command: 'create',
        ok: false,
        error: {
          code: 'PREFLIGHT',
          message: 'original readiness failure',
          outcome: 'retained',
          machine: sprite.name,
          machineId: sprite.id,
          setupIncomplete: true,
        },
        data: {
          recovery: { privacy, incompleteLabel: label },
        },
      });
      expect(sprite.urlSettings.auth).toBe(privacyFails ? 'public' : 'sprite');
      expect(sprite.labels.includes(SETUP_INCOMPLETE_LABEL)).toBe(!labelFails);
    },
  );

  it('should redact retained failure output and writes one JSON object', async () => {
    const { sprite, mutations, visibility, labels } = createSprite();
    const secret = 'cor04-generated-recovery-secret';
    rememberSecret(secret);
    const privacyFailure = new Error('privacy unavailable');
    const labelFailure = new Error('label unavailable');
    visibility.mockImplementation(async (settings) => {
      mutations.push(`visibility:${settings.auth}`);
      throw privacyFailure;
    });
    labels.mockImplementation(async () => {
      mutations.push('labels:incomplete');
      throw labelFailure;
    });
    const prior = new Error('prior provider cause');
    const primary = new CommandFault({
      code: 'PROVIDER',
      message: `provider rejected ${secret}`,
      cause: prior,
    });
    const result = await markCreateIncomplete(dependencies, {
      workstation: toRecord(sprite),
      context: createContext(sprite),
      error: primary,
    });

    expect(mutations).toEqual(['visibility:sprite', 'labels:incomplete']);
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toEqual([
      prior,
      privacyFailure,
      labelFailure,
    ]);
    expect(result).toMatchObject({
      error: {
        code: 'PROVIDER',
        machineId: sprite.id,
        details: [
          expect.stringContaining('privacy unavailable'),
          expect.stringContaining('label unavailable'),
          expect.stringContaining('prior provider cause'),
          expect.stringContaining(
            'Private URL authentication could not be confirmed',
          ),
          expect.stringContaining('incomplete label could not be confirmed'),
          expect.stringContaining('Workstation ready-workstation was retained'),
        ],
      },
      data: {
        recovery: { privacy: 'unconfirmed', incompleteLabel: 'unconfirmed' },
      },
    });
    const human = captureResult(result, {});
    const json = captureResult(result, { json: true });
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('Workstation ID: sprite-ready-42');
    expect(human.stderr).toContain(
      'Private URL authentication could not be confirmed',
    );
    expect(human.stderr).toContain('incomplete label could not be confirmed');
    expect(json.stderr).toBe('');
    expect(json.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'create',
      ok: false,
      error: { code: 'PROVIDER', machineId: sprite.id },
      data: {
        recovery: { privacy: 'unconfirmed', incompleteLabel: 'unconfirmed' },
      },
    });
    expect(`${human.stderr}${json.stdout}`).toContain('[REDACTED]');
    expect(`${human.stderr}${json.stdout}`).not.toContain(secret);
  });
});

describe('fn:finishCreate', () => {
  it('should retain a create failure after closing its session', async () => {
    const primary = new Error('configuration failed');
    vi.spyOn(CONTEXT.provider, 'openGuest').mockImplementationOnce(
      async () => CHANNEL,
    );
    vi.mocked(configureNewWorkstation).mockImplementationOnce(async () => {
      throw primary;
    });
    const close = vi.fn(async () => undefined);
    const connection = {
      close,
    } satisfies Partial<SetupSession> as Partial<SetupSession> as SetupSession;
    const wired = dependenciesWith({
      guest: {
        ...dependencies.guest,
        session: { connect: () => connection },
      },
    });

    await expect(
      finishCreate(wired, { workstation: WORKSTATION, context: CONTEXT }),
    ).rejects.toBe(primary);
    expect(close.mock.calls).toEqual([[]]);
  });

  it('should retain a successful create result when session closes', async () => {
    vi.spyOn(CONTEXT.provider, 'openGuest').mockImplementationOnce(
      async () => CHANNEL,
    );
    vi.spyOn(CONTEXT.provider, 'expose').mockImplementationOnce(
      async () => undefined,
    );
    vi.spyOn(CONTEXT.provider, 'setMetadata').mockImplementationOnce(
      async () => ({ ...WORKSTATION, metadata: { setup: 'ready' } }),
    );
    vi.mocked(configureNewWorkstation).mockImplementationOnce(
      async () => CHANNEL,
    );
    vi.mocked(inspectUntilServing).mockImplementationOnce(async () => OBSERVED);
    const close = vi.fn(async () => undefined);
    const connection = {
      close,
    } satisfies Partial<SetupSession> as Partial<SetupSession> as SetupSession;
    const wired = dependenciesWith({
      guest: {
        ...dependencies.guest,
        session: { connect: () => connection },
      },
    });

    const result = await finishCreate(wired, {
      workstation: WORKSTATION,
      context: CONTEXT,
    });

    expect(result).toMatchObject({
      command: 'create',
      ok: true,
      data: { machine: { id: WORKSTATION.id, setup: 'ready' } },
    });
    expect(close.mock.calls).toEqual([[]]);
  });
});
