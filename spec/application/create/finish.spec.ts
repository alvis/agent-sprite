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
import { markCreateIncomplete } from '#application/create/failure';
import { finalizeCreate } from '#application/create/finish';
import {
  normalizePluginOptions,
  resolvePluginActions,
} from '#application/plugins';
import { resultExitCode } from '#cli/exit';
import { writeResult } from '#cli/output';

import { CommandFault } from '#kernel/faults';
import { OperationContext, withOperation } from '#kernel/operation';
import { rememberSecret } from '#kernel/redaction';

import { environmentOf } from '../../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';

import { dependencies } from '../../mocks/dependencies';
import { guestOf, providerOf } from '../../mocks/sprites';

import type { CommandOptions } from '#application/contracts';
import type { CreateContext } from '#application/create/context';
import type { CommandResult } from '#application/result';
import type { GuestInspection } from '#domain/observations/inspection';

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
 * Provides one identified SDK Sprite with real finalization and controlled SDK writes.
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
 * Supplies verified create inputs without invoking preflight or an installer.
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
 * Captures both real output destinations for a completed domain result.
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
  let err = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  try {
    writeResult(result, options, { stdout, stderr });
  } finally {
    stdout.destroy();
    stderr.destroy();
  }

  return { stdout: out, stderr: err };
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
