import type { AwakeHookCommand } from '#application/ports/drivers';
import type { GuestFacts } from '#application/ports/guest';

/**
 * builds the idle-governor command the work hooks of every harness invoke
 * @param facts the path the guest installs the governor script at
 * @returns the program each harness work hook runs
 */
export function awakeHookCommand(
  facts: Pick<GuestFacts, 'awakeCommand'>,
): AwakeHookCommand {
  return { program: facts.awakeCommand };
}
