import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { debianFamily } from '#adapters/guest/os/debian/family';
import { installWorkstation } from '#application/installation';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { environmentOf } from '../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile';
import { dependencies } from '../mocks/dependencies';
import { standInSession } from '../mocks/session';
import { createFilesystemSprite, guestOf } from '../mocks/sprites';

import type { GuestMechanics } from '#application/ports/guest';
import type { Interaction } from '#application/ports/interaction';
import type {
  PlanReport,
  SetupAssembly,
  SetupStep,
} from '#application/ports/plan';
import type { SetupSession } from '#application/ports/session';

const step = (id: string): SetupStep => ({
  id,
  component: 'tools',
  account: 'root',
  needs: [],
  apply: { argv: ['true'] },
  timeoutMs: 1000,
  critical: true,
  retry: 'never',
});

const foundation = step('foundation');
const tool = step('tool');
const service = step('service');
const environment = environmentOf(DISABLED_NETWORK_PROFILE);
const recordedService =
  dependencies.registry.agents[DISABLED_NETWORK_PROFILE.agent].service;
const assembly: SetupAssembly = {
  family: debianFamily,
  tools: [],
  resolutions: [],
  environment,
  foundation: [foundation],
  steps: [tool],
  services: [service],
};

async function installationBoundary() {
  const directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-installation-'),
  );
  const guest = guestOf(createFilesystemSprite({ root: directory.path }));
  const base = standInSession(guest);
  const open = vi.fn(async () => base);
  const lend = vi.fn(async () => base);
  const connection = {
    ...base,
    open,
    reopen: async () => base,
    lend,
    close: async () => undefined,
    guest: async () => guest,
  } satisfies SetupSession;
  const assemble = vi.fn<GuestMechanics['plan']['assemble']>(
    async () => assembly,
  );
  const needsBottleProbe = vi.fn<GuestMechanics['plan']['needsBottleProbe']>(
    () => false,
  );
  const probeBottles = vi.fn<GuestMechanics['plan']['probeBottles']>(
    async () => [],
  );
  const run = vi.fn<GuestMechanics['plan']['run']>(async () => ({
    isComplete: true,
    steps: [],
  }));
  const installProvider = vi.fn<GuestMechanics['services']['installProvider']>(
    async () => undefined,
  );
  const mechanics = {
    plan: {
      ...dependencies.guest.plan,
      assemble,
      needsBottleProbe,
      probeBottles,
      run,
    },
    services: { installProvider },
  };

  return {
    [Symbol.asyncDispose]: async () => directory[Symbol.asyncDispose](),
    connection,
    guest,
    open,
    lend,
    assemble,
    needsBottleProbe,
    probeBottles,
    run,
    installProvider,
    mechanics,
  };
}

describe('fn:installWorkstation', () => {
  it('should preserve the earlier identity and start provider services after caller configuration', async () => {
    await using boundary = await installationBoundary();
    const events: string[] = [];
    const previous = environmentOf(DISABLED_NETWORK_PROFILE, {
      networkIdentity: { network: 'tailscale', deviceId: 'old-device' },
      services: [{ ...recordedService, name: 'old-service' }, recordedService],
    });
    boundary.run.mockImplementation(
      async ({ steps, openSession, onProgress }) => {
        events.push(`plan:${steps.map(({ id }) => id).join(',')}`);
        await openSession(42);
        onProgress?.({ kind: 'step-started', step: steps[0]!, attempt: 1 });

        return { isComplete: true, steps: [] };
      },
    );
    boundary.installProvider.mockImplementation(async () => {
      events.push('provider-services');
    });
    const beforeServices = vi.fn(async () => {
      events.push('before-services');
    });
    const progress = vi.fn<Interaction['progress']>();
    const interaction: Interaction = {
      input: async () => '',
      secret: async () => '',
      select: async (_prompt, choices) => choices[0]!.value,
      multiselect: async () => [],
      confirm: async () => true,
      progress,
      status: () => undefined,
    };

    const result = await installWorkstation(boundary.mechanics, {
      provider: dependencies.registry.providers.sprite,
      connection: boundary.connection,
      profile: DISABLED_NETWORK_PROFILE,
      previous,
      interaction,
      beforeServices,
    });

    expect(result).toEqual(environment);
    expect(boundary.open).toHaveBeenCalledOnce();
    expect(boundary.lend.mock.calls).toEqual([[42], [42]]);
    expect(boundary.assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: dependencies.registry.providers.sprite,
        profile: DISABLED_NETWORK_PROFILE,
        release: boundary.connection.release,
        version: OPEN_AGENT_VERSION,
        setupAt: expect.any(String),
        networkIdentity: previous.networkIdentity,
      }),
    );
    expect(beforeServices.mock.calls).toEqual([[boundary.guest]]);
    expect(progress.mock.calls).toEqual([
      [
        {
          stage: 'tools',
          message: expect.stringContaining('foundation'),
          phase: 'start',
        },
      ],
      [
        {
          stage: 'tools',
          message: expect.stringContaining('service'),
          phase: 'start',
        },
      ],
    ]);
    expect(boundary.installProvider).toHaveBeenCalledWith({
      control: boundary.guest.services,
      services: environment.services,
      previous: ['old-service', recordedService.name],
    });
    expect(events).toEqual([
      'plan:foundation,tool',
      'before-services',
      'plan:service',
      'provider-services',
    ]);
  });

  it('should run foundation before probing bottles and reuse the plan when all are available', async () => {
    await using boundary = await installationBoundary();
    boundary.needsBottleProbe.mockReturnValue(true);

    const result = await installWorkstation(boundary.mechanics, {
      provider: dependencies.registry.providers['fly-machine'],
      connection: boundary.connection,
      profile: DISABLED_NETWORK_PROFILE,
    });

    expect(result).toEqual(environment);
    expect(boundary.run.mock.calls.map(([{ steps }]) => steps)).toEqual([
      [foundation],
      [foundation, tool],
      [service],
    ]);
    expect(boundary.probeBottles.mock.calls).toEqual([
      [boundary.connection, assembly],
    ]);
    expect(boundary.assemble).toHaveBeenCalledOnce();
    expect(boundary.installProvider).not.toHaveBeenCalled();
  });

  it('should reassemble with refused bottles before installing tools', async () => {
    await using boundary = await installationBoundary();
    const refused = {
      tool: 'example',
      source: { kind: 'npm', package: 'example', account: 'agent' },
      reason: 'no bottle',
    } as const;
    boundary.needsBottleProbe.mockReturnValue(true);
    boundary.probeBottles.mockResolvedValue([refused]);
    boundary.assemble.mockResolvedValueOnce(assembly).mockResolvedValueOnce({
      ...assembly,
      steps: [step('alternative-source')],
    });

    const result = await installWorkstation(boundary.mechanics, {
      provider: dependencies.registry.providers.sprite,
      connection: boundary.connection,
      profile: DISABLED_NETWORK_PROFILE,
    });

    const base = {
      provider: dependencies.registry.providers.sprite,
      profile: DISABLED_NETWORK_PROFILE,
      release: boundary.connection.release,
      version: OPEN_AGENT_VERSION,
      setupAt: expect.any(String),
      networkIdentity: undefined,
    };
    expect({ result, assemblies: boundary.assemble.mock.calls }).toEqual({
      result: environment,
      assemblies: [[base], [{ ...base, refused: [refused] }]],
    });
    expect(boundary.run.mock.calls.map(([{ steps }]) => steps)).toEqual([
      [foundation],
      [foundation, step('alternative-source')],
      [service],
    ]);
  });

  it.each([
    {
      case: 'critical failure with a reason',
      report: {
        isComplete: false,
        steps: [
          { step: tool, status: 'failed', attempts: 1, reason: 'disk full' },
          { step: service, status: 'skipped', attempts: 0 },
        ],
      },
      details: ['tool: disk full'],
      message: 'tool',
    },
    {
      case: 'critical failure without a reason',
      report: {
        isComplete: false,
        steps: [{ step: tool, status: 'failed', attempts: 1 }],
      },
      details: ['tool: failed'],
      message: 'tool',
    },
    {
      case: 'no failed step',
      report: { isComplete: false, steps: [] },
      details: [],
      message: 'a critical step',
    },
  ] satisfies Array<{
    case: string;
    report: PlanReport;
    details: string[];
    message: string;
  }>)(
    'should stop before services on $case',
    async ({ report, details, message }) => {
      await using boundary = await installationBoundary();
      boundary.run.mockResolvedValueOnce(report);

      await expect(
        installWorkstation(boundary.mechanics, {
          provider: dependencies.registry.providers.sprite,
          connection: boundary.connection,
          profile: DISABLED_NETWORK_PROFILE,
        }),
      ).rejects.toMatchObject({
        code: 'PROVIDER',
        message: expect.stringContaining(message),
        details,
      });
      expect(boundary.installProvider).not.toHaveBeenCalled();
      expect(boundary.run).toHaveBeenCalledOnce();
    },
  );
});
