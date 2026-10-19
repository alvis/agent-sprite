import { CommandFault } from '#kernel/faults';

import { bottleProbe, HOMEBREW_STEP, refusedBottles } from './steps/homebrew';

import type { SetupAssembly } from '#application/ports/plan';
import type { GuestSession } from '#application/ports/session';
import type { RefusedSource } from '#domain/tools';

/** longest the bottle probe runs when it names no limit of its own */
const PROBE_LIMIT_MS = 300_000;

/**
 * tells whether the plan installs Homebrew formulae whose bottles the
 * installed Homebrew should be asked about: the foundation installs Homebrew
 * and a tool resolved to a formula
 * @param assembly the assembled plan
 * @returns true when the probe has something to ask
 */
export function needsBottleProbe(assembly: SetupAssembly): boolean {
  return (
    bottleProbe(assembly.family, assembly.resolutions) !== undefined &&
    assembly.foundation.some(({ id }) => id === HOMEBREW_STEP)
  );
}

/**
 * asks the installed Homebrew which formulae have no bottle
 * @param session the setup session, whose foundation has run
 * @param assembly the assembled plan
 * @returns the sources the guest turns down, so resolving again falls through to the next
 * @throws {CommandFault} when Homebrew cannot report
 */
export async function probeBottles(
  session: Pick<GuestSession, 'run'>,
  assembly: SetupAssembly,
): Promise<RefusedSource[]> {
  const probe = bottleProbe(assembly.family, assembly.resolutions);
  if (!probe) {
    return [];
  }
  const { exitCode, stdout, stderr } = await session.run({
    ...probe,
    account: 'root',
    timeoutMs: probe.timeoutMs ?? PROBE_LIMIT_MS,
  });
  if (exitCode !== 0) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: 'Homebrew could not report which formulae have a bottle',
      details: stderr.trim() ? [stderr.trim()] : [],
    });
  }

  return refusedBottles(stdout, assembly.resolutions);
}
