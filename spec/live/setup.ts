import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLiveHarness, readLiveRunConfiguration } from './harness';
import { FLY_LIVE_PROJECT } from './identity';

import type { TestProject } from 'vitest/node';

/**
 * prefix of the isolated home: short on purpose, because flyctl's agent binds a
 * Unix socket below it (`.config/open-agent/flyctl/fly-agent.sock`, 38
 * characters), and macOS accepts at most 103 characters of socket path, which
 * a temporary directory of 50 characters plus a long prefix exceeds
 */
const HOME_PREFIX = 'oa-';

/**
 * prepares one live run and returns the sweep that always runs at shutdown
 * @param project live vitest project receiving the run context
 * @returns teardown removing every workstation of the run and proving absence
 */
export async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const configuration = readLiveRunConfiguration(process.env);
  const home = await mkdtemp(join(tmpdir(), HOME_PREFIX));
  const context = {
    ...configuration,
    home,
    fly: project.name === FLY_LIVE_PROJECT,
  };
  try {
    const harness = await createLiveHarness(context);
    if (!configuration.sweep) {
      await harness.cleanup.assertUnused();
    }
    project.provide('live', context);

    return async () => {
      // vitest only logs teardown errors and may exit mid-teardown, so the run
      // stays failed until the sweep has proved every workstation absent
      const { exitCode } = process;
      process.exitCode = 1;
      try {
        await harness.cleanup.sweep();
        process.exitCode = exitCode;
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
