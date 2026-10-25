import { describe, expect, it } from 'vitest';

import { assemblePlan } from '#adapters/guest/plan/assemble';
import { runPlan } from '#adapters/guest/plan/plan';
import { registry } from '#composition/registry';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { DISABLED_NETWORK_PROFILE } from '../../../fixtures/profile';

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
});
