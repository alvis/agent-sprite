import { APIError, Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import {
  MANAGED_LABEL,
  SCHEMA_LABEL,
} from '#adapters/drivers/providers/sprite/labels';
import {
  authorizationFailure,
  creationOutcome,
  markCreateIncomplete,
} from '#application/create/failure';
import {
  normalizePluginOptions,
  resolvePluginActions,
} from '#application/plugins';
import { ReadinessFault } from '#application/readiness';
import { prepareResult } from '#cli/output';
import { projectResult } from '#cli/output/project';
import { serializeResult } from '#cli/serialization';
import { WorkstationCreationFault } from '#domain/creation';

import { CommandFault } from '#kernel/faults';
import { InteractionExit } from '#kernel/navigation';
import { rememberSecret } from '#kernel/redaction';

import {
  DEFAULT_AGENT_PORT,
  DISABLED_NETWORK_PROFILE,
} from '../../fixtures/profile';

import { dependencies } from '../../mocks/dependencies';
import { providerOf } from '../../mocks/sprites';

import type { CreateContext } from '#application/create/context';
import type { WorkstationRecord } from '#domain/workstation';

describe('cmd:create failure', () => {
  describe('reconciled creation failures', () => {
    const preflight = { checks: ['name was checked'], reminders: [] };

    it('should rethrow failures without a reconciled provider outcome', () => {
      const error = new Error('local preparation failed');

      expect(() => creationOutcome(error, preflight)).toThrow(error);
    });

    it('should preserve cancellation after a retained workstation was observed', () => {
      const result = creationOutcome(
        new WorkstationCreationFault({
          message: 'Creation was interrupted after provider acceptance',
          machine: 'interrupted-machine',
          machineId: 'sprite-interrupted',
          outcome: 'retained',
          cause: new InteractionExit('cancel'),
        }),
        preflight,
      );

      expect(result).toMatchObject({
        command: 'create',
        ok: false,
        data: { preflight },
        error: {
          code: 'CANCELLED',
          outcome: 'retained',
          machine: 'interrupted-machine',
          machineId: 'sprite-interrupted',
          setupIncomplete: true,
          details: expect.arrayContaining([
            'Creation cause: Cancelled by user.',
            'The retained workstation requires setup before use.',
          ]),
        },
      });
    });

    it('should keep a typed failure for an unknown outcome but allow retry after confirmed absence', () => {
      const cause = new CommandFault({
        code: 'PREFLIGHT',
        message: 'Provider rejected the requested profile',
        details: ['Change the requested profile.'],
      });
      const failure = {
        message: 'Creation could not finish',
        machine: 'rejected-machine',
        cause,
      };

      const unknown = creationOutcome(
        new WorkstationCreationFault({ ...failure, outcome: 'unknown' }),
        preflight,
      );
      const absent = creationOutcome(
        new WorkstationCreationFault({ ...failure, outcome: 'absent' }),
        preflight,
      );

      expect(unknown).toMatchObject({
        error: {
          code: 'PREFLIGHT',
          outcome: 'unknown',
          details: [
            'Change the requested profile.',
            'Creation cause: Provider rejected the requested profile',
            'Inspect the provider for a workstation with this name before retrying.',
          ],
        },
      });
      expect(absent).toMatchObject({
        error: {
          code: 'PROVIDER',
          outcome: 'absent',
          details: [
            'Change the requested profile.',
            'Creation cause: Provider rejected the requested profile',
            'Provider lookup confirmed this workstation is absent; creation can be retried.',
          ],
        },
      });
    });

    it('should omit an empty creation cause from the diagnostic details', () => {
      const result = creationOutcome(
        new WorkstationCreationFault({
          message: 'Creation state is unknown',
          machine: 'quiet-machine',
          outcome: 'unknown',
          cause: new Error(''),
        }),
        preflight,
      );

      expect(result).toMatchObject({
        error: {
          code: 'PROVIDER',
          outcome: 'unknown',
          details: [
            'Inspect the provider for a workstation with this name before retrying.',
          ],
        },
      });
    });
  });

  it('should retain verified preflight, exact name and immutable ID after an uncertain provider create', async () => {
    const client = new SpritesClient('sdk-only-test-token');
    const sprite = Object.assign(new Sprite('new-workstation', client), {
      id: 'sprite-retained',
      labels: [MANAGED_LABEL, SCHEMA_LABEL],
    });
    vi.spyOn(client, 'createSprite').mockRejectedValue(
      new Error('provider timed out'),
    );
    vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);
    const preflight = {
      checks: ['provider name was available'],
      reminders: ['complete setup before use'],
    };

    const result = await providerOf(client)
      .create(sprite.name, DISABLED_NETWORK_PROFILE, DEFAULT_AGENT_PORT)
      .then(
        () => {
          throw new Error('Expected provider creation to fail');
        },
        (error: unknown) => creationOutcome(error, preflight),
      );

    expect(result).toMatchObject({
      command: 'create',
      ok: false,
      error: {
        code: 'PROVIDER',
        machine: sprite.name,
        machineId: sprite.id,
        outcome: 'retained',
        setupIncomplete: true,
      },
      data: { preflight },
    });
    expect(serializeResult(projectResult(result))).toMatchObject({
      schemaVersion: 1,
      data: { preflight },
      error: { machine: sprite.name, machineId: sprite.id },
    });
  });

  it('should report an unknown provider outcome without inventing an ID', async () => {
    const client = new SpritesClient('sdk-only-test-token');
    vi.spyOn(client, 'createSprite').mockRejectedValue(
      new Error('provider timed out'),
    );
    vi.spyOn(client, 'getSprite').mockRejectedValue(
      new Error('reconciliation unavailable'),
    );

    const result = await providerOf(client)
      .create('new-workstation', DISABLED_NETWORK_PROFILE, DEFAULT_AGENT_PORT)
      .then(
        () => {
          throw new Error('Expected provider creation to fail');
        },
        (error: unknown) =>
          creationOutcome(error, {
            checks: ['name was checked'],
            reminders: [],
          }),
      );

    expect(result).toMatchObject({
      command: 'create',
      ok: false,
      error: {
        code: 'PROVIDER',
        machine: 'new-workstation',
        outcome: 'unknown',
      },
      data: { preflight: { checks: ['name was checked'] } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected a create failure');
    }
    expect(result.error.machineId).toBeUndefined();
  });

  it('should report definite absence only after a rejected create and exact SDK APIError 404 lookup', async () => {
    const client = new SpritesClient('sdk-only-test-token');
    const secret = 'create-provider-sensitive-token';
    rememberSecret(secret);
    const cause = new Error(`provider rejected ${secret} ${'x'.repeat(700)}`);
    const create = vi.spyOn(client, 'createSprite').mockRejectedValue(cause);
    const lookup = vi
      .spyOn(client, 'getSprite')
      .mockRejectedValue(new APIError('missing', { statusCode: 404 }));
    const preflight = { checks: ['name was checked'], reminders: [] };
    const result = await providerOf(client)
      .create('absent-machine', DISABLED_NETWORK_PROFILE, DEFAULT_AGENT_PORT)
      .then(
        () => {
          throw new Error('Expected provider creation to fail');
        },
        (error: unknown) => creationOutcome(error, preflight),
      );

    expect(create).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      command: 'create',
      ok: false,
      error: { code: 'PROVIDER', machine: 'absent-machine', outcome: 'absent' },
      data: { preflight },
    });
    if (result.ok) {
      throw new Error('Expected a failed result');
    }
    expect(result.error.machineId).toBeUndefined();
    expect(result.error.details?.[0]?.length).toBeLessThanOrEqual(
      512 + 'Creation cause: '.length,
    );
    const human = prepareResult({ result, options: {} });
    const json = prepareResult({ result, options: { json: true } });
    expect(human.channel).toBe('stderr');
    expect(human.text).toContain(
      'Provider lookup confirmed this workstation is absent',
    );
    expect(json.channel).toBe('stdout');
    expect(JSON.parse(json.text)).toMatchObject({
      error: { outcome: 'absent' },
    });
    expect(json.text.trim().split('\n')).toHaveLength(1);
    for (const output of [human.text, json.text]) {
      expect(output).toContain('Creation cause: provider rejected [REDACTED]');
      expect(output).not.toContain(secret);
      expect(output).not.toContain('x'.repeat(600));
    }
  });
});

describe('cmd:create retained setup recovery', () => {
  const workstation = {
    id: 'sprite-recover-42',
    name: 'recover-machine',
    organization: 'test',
    state: 'running',
    url: 'https://recover-machine.example.test/',
    metadata: { setup: 'incomplete' },
  } satisfies WorkstationRecord;

  it.each([
    {
      privacyFails: false,
      labelFails: false,
      hasReadiness: true,
      privacy: 'confirmed',
      label: 'confirmed',
    },
    {
      privacyFails: true,
      labelFails: true,
      hasReadiness: true,
      privacy: 'unconfirmed',
      label: 'unconfirmed',
    },
    {
      privacyFails: false,
      labelFails: false,
      hasReadiness: false,
      privacy: 'confirmed',
      label: 'confirmed',
    },
  ] as const)(
    'should preserve readiness=$hasReadiness and report private visibility=$privacy, incomplete label=$label',
    async ({ privacyFails, labelFails, hasReadiness, privacy, label }) => {
      const client = new SpritesClient('sdk-only-test-token');
      const provider = providerOf(client);
      const expose = vi
        .spyOn(provider, 'expose')
        .mockImplementation(async () => {
          if (privacyFails) {
            throw new Error('private visibility unavailable');
          }
        });
      const setMetadata = vi
        .spyOn(provider, 'setMetadata')
        .mockImplementation(async () => {
          if (labelFails) {
            throw new Error('incomplete label unavailable');
          }

          return workstation;
        });
      const preflight = {
        checks: ['provider name was available'],
        reminders: [],
      };
      const context = {
        options: {},
        input: {
          name: workstation.name,
          providerToken: 'sdk-only-test-token',
          profile: DISABLED_NETWORK_PROFILE,
          runtimeEnv: {},
          sources: {},
          missing: [],
        },
        name: workstation.name,
        token: 'sdk-only-test-token',
        plugins: resolvePluginActions(normalizePluginOptions({})),
        preflight,
        provider,
      } satisfies CreateContext;
      const readiness = {
        ready: false,
        failures: ['agent service'],
        skipped: [],
        probeFailures: [],
      };
      const primary = hasReadiness
        ? new ReadinessFault(readiness)
        : new Error('setup failed');

      const result = await markCreateIncomplete(dependencies, {
        workstation,
        context,
        error: primary,
      });

      expect(expose).toHaveBeenCalledExactlyOnceWith(
        workstation,
        DEFAULT_AGENT_PORT,
        'private',
      );
      expect(setMetadata).toHaveBeenCalledExactlyOnceWith(workstation, {
        setup: 'incomplete',
        version: expect.any(String),
      });
      expect(result).toMatchObject({
        command: 'create',
        ok: false,
        data: {
          preflight,
          readiness: hasReadiness ? readiness : undefined,
          recovery: { privacy, incompleteLabel: label },
        },
        error: {
          code: hasReadiness ? 'PREFLIGHT' : 'UNEXPECTED',
          outcome: 'retained',
          machine: workstation.name,
          machineId: workstation.id,
          setupIncomplete: true,
        },
      });
      if (result.ok) {
        throw new Error('Expected incomplete setup');
      }
      expect(result.error.details).toContain(
        `Workstation ${workstation.name} was retained. Run open-agent setup ${workstation.name} to recover.`,
      );
      if (privacyFails) {
        expect(result.error.details).toContain(
          'Private URL authentication could not be confirmed; inspect provider visibility.',
        );
        expect(result.error.details).toContain(
          'The incomplete label could not be confirmed; inspect provider state.',
        );
      } else {
        expect(result.error.details).not.toContain(
          'Private URL authentication could not be confirmed; inspect provider visibility.',
        );
        expect(result.error.details).not.toContain(
          'The incomplete label could not be confirmed; inspect provider state.',
        );
      }
    },
  );
});

describe('cmd:create authorization failure', () => {
  it('should preserve back navigation before provider creation', () => {
    const back = new InteractionExit('back');

    expect(() => authorizationFailure(back)).toThrow(back);
  });

  it('should preserve a cancellation without claiming a workstation was created', () => {
    const result = authorizationFailure(new InteractionExit('cancel'));
    if (result.kind !== 'result') {
      throw new Error('Expected a creation authorization failure');
    }

    expect(result).toMatchObject({
      kind: 'result',
      result: {
        command: 'create',
        ok: false,
        error: {
          code: 'CANCELLED',
          message: 'Cancelled by user.',
          details: ['Cancelled by user.'],
        },
      },
    });
    expect(result.result).not.toHaveProperty('data');
    expect(result.result.error).not.toHaveProperty('machine');
    expect(result.result.error).not.toHaveProperty('machineId');
  });

  it('should report a typed authorization fault with its safe detail and no resource identity', () => {
    const result = authorizationFailure(
      new CommandFault({
        code: 'AUTH',
        message: 'Enrollment was denied',
        details: ['Ask the organization administrator for access.'],
      }),
    );
    if (result.kind !== 'result') {
      throw new Error('Expected a creation authorization failure');
    }

    expect(result).toMatchObject({
      kind: 'result',
      result: {
        command: 'create',
        ok: false,
        error: {
          code: 'AUTH',
          message: 'Creation authorization failed; no workstation was created',
          details: [
            'Ask the organization administrator for access.',
            'Enrollment was denied',
          ],
        },
      },
    });
    expect(result.result).not.toHaveProperty('data');
    expect(result.result.error).not.toHaveProperty('machine');
    expect(result.result.error).not.toHaveProperty('machineId');
  });
});
