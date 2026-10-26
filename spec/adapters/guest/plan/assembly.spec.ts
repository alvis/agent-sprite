import { describe, expect, it } from 'vitest';

import { assemblePlan, assertImageTools } from '#adapters/guest/plan/assembly';
import { runPlan } from '#adapters/guest/plan/execution';
import { registry } from '#composition/registry';
import { CommandFault } from '#kernel/faults';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { DISABLED_NETWORK_PROFILE } from '../../../fixtures/profile';

import type { DriverRegistry } from '#application/ports/drivers';
import type { SetupStep, StepOutcome } from '#application/ports/plan';
import type { GuestSession } from '#application/ports/session';
import type { OsRelease } from '#domain/guest';

/** the release the stand-in guest reports */
const RELEASE: OsRelease = {
  family: 'debian',
  id: 'debian',
  versionId: '12',
  codename: 'bookworm',
  arch: 'x86_64',
  libc: 'glibc',
};

/** a workstation following T3 Code's nightly channel */
const NIGHTLY_PROFILE = {
  ...DISABLED_NETWORK_PROFILE,
  options: { ...DISABLED_NETWORK_PROFILE.options, agentRelease: 'nightly' },
};

const AGENT_CLI = registry.agents.t3.tools[0];
const CLAUDE_TOOL = registry.harnesses.claude.tools[0];
if (!AGENT_CLI || !CLAUDE_TOOL) {
  throw new Error(
    'The plan test requires the registered agent and harness tools',
  );
}

/**
 * runs one tool's step of a nightly workstation's plan on a guest where the
 * tool's executable runs, and the installed T3 Code is not the version the
 * nightly dist-tag names now
 * @param tool the tool whose step runs, without the steps it needs
 * @returns the step's status and the shell scripts the guest ran
 */
async function runToolStep(
  tool: string,
): Promise<{ statuses: Array<StepOutcome['status']>; scripts: string[] }> {
  const assembly = await assemblePlan(registry, {
    provider: registry.providers['fly-machine'],
    profile: NIGHTLY_PROFILE,
    release: RELEASE,
    version: OPEN_AGENT_VERSION,
    setupAt: '2026-10-25T00:00:00Z',
  });
  const step = assembly.steps.find(({ id }) => id === `tool:${tool}`);
  if (!step) {
    throw new Error(`The plan has no step for ${tool}`);
  }
  const scripts: string[] = [];
  const session: GuestSession = {
    release: RELEASE,
    pid: 1,
    run: async ({ argv }) => {
      const script = argv.join(' ');
      scripts.push(script);

      return {
        exitCode: script.includes('oa_npm_current') ? 1 : 0,
        stdout: '',
        stderr: '',
      };
    },
    [Symbol.asyncDispose]: async () => undefined,
  };
  const isolated: SetupStep = { ...step, needs: [] };

  const report = await runPlan({
    steps: [isolated],
    openSession: async () => session,
  });

  return { statuses: report.steps.map(({ status }) => status), scripts };
}

describe('fn:assemblePlan', () => {
  it('should install the channel release over an installed T3 Code whose version probe passes', async () => {
    const { statuses, scripts } = await runToolStep('t3');

    expect(statuses).toEqual(['applied']);
    expect(
      scripts.some((script) =>
        script.includes("'oa_npm_current' 't3' 'nightly'"),
      ),
    ).toBe(true);
    expect(
      scripts.some((script) =>
        script.includes("'oa_npm_install' 't3' 'nightly'"),
      ),
    ).toBe(true);
  });

  it('should leave an npm tool that follows no channel to its version probe', async () => {
    const { statuses, scripts } = await runToolStep('bun');

    expect(statuses).toEqual(['satisfied']);
    expect(scripts.some((script) => script.includes('oa_npm_install'))).toBe(
      false,
    );
  });

  it('should keep the first shared tool, install an ACP adapter, and retain network identity', async () => {
    const originalTool = CLAUDE_TOOL;
    const adapterTool = { ...originalTool, name: 'claude-acp' };
    const selectedRegistry = {
      ...registry,
      harnesses: {
        ...registry.harnesses,
        claude: {
          ...registry.harnesses.claude,
          tools: [
            originalTool,
            {
              ...originalTool,
              sources: [
                { kind: 'npm', package: 'later-declaration', account: 'agent' },
              ],
            },
          ],
          acpAdapter: {
            tool: adapterTool,
            launch: { program: 'claude-acp', arguments: [] },
          },
        },
      },
    } satisfies DriverRegistry;
    const networkIdentity = { network: 'none' as const, deviceId: 'retained' };

    const assembly = await assemblePlan(selectedRegistry, {
      provider: registry.providers['fly-machine'],
      profile: DISABLED_NETWORK_PROFILE,
      release: RELEASE,
      version: OPEN_AGENT_VERSION,
      setupAt: '2026-10-25T00:00:00Z',
      networkIdentity,
    });

    expect(assembly).toEqual(
      expect.objectContaining({
        tools: expect.arrayContaining([originalTool, adapterTool]),
        environment: expect.objectContaining({
          networkIdentity,
          agent: expect.objectContaining({
            harnesses: expect.arrayContaining([
              expect.objectContaining({
                id: 'claude',
                adapter: expect.objectContaining({ tool: 'claude-acp' }),
              }),
            ]),
          }),
        }),
      }),
    );
    expect(
      assembly.tools.filter(({ name }) => name === originalTool.name),
    ).toEqual([originalTool]);
  });

  it('should assemble a plan without an agent CLI when its driver declares no tools', async () => {
    const selectedRegistry = {
      ...registry,
      agents: { t3: { ...registry.agents.t3, tools: [] } },
    } satisfies DriverRegistry;

    const assembly = await assemblePlan(selectedRegistry, {
      provider: registry.providers['fly-machine'],
      profile: DISABLED_NETWORK_PROFILE,
      release: RELEASE,
      version: OPEN_AGENT_VERSION,
      setupAt: '2026-10-25T00:00:00Z',
    });

    expect(assembly).toEqual(
      expect.objectContaining({
        tools: expect.not.arrayContaining([
          expect.objectContaining({ name: 't3' }),
        ]),
        steps: expect.not.arrayContaining([
          expect.objectContaining({ id: 'tool:t3' }),
        ]),
      }),
    );
  });
});

describe('fn:assertImageTools', () => {
  const unavailableRegistry = {
    ...registry,
    agents: {
      t3: {
        ...registry.agents.t3,
        tools: [
          {
            ...AGENT_CLI,
            sources: [
              {
                kind: 'system',
                family: 'debian',
                packages: ['t3-code'],
                when: { arch: ['aarch64'] },
              },
            ],
          },
        ],
      },
    },
  } as const satisfies DriverRegistry;

  it('should defer tool compatibility when the provider image has no declared release', () => {
    expect(() =>
      assertImageTools(
        unavailableRegistry,
        registry.providers.sprite,
        DISABLED_NETWORK_PROFILE,
      ),
    ).not.toThrow();
  });

  it('should reject an image whose declared architecture cannot install a required tool', () => {
    const provider = {
      serviceBackend: 'provider',
      images: [
        {
          id: 'unsupported-tool-architecture',
          family: 'debian',
          release: { id: 'debian', versionId: '12' },
          arch: ['x86_64'],
        },
      ],
    } as const;

    expect(() =>
      assertImageTools(unavailableRegistry, provider, DISABLED_NETWORK_PROFILE),
    ).toThrow(CommandFault);
  });
});
