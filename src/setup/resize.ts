import { isSameMachine, pickMachine } from '#drivers/machine-sizes';
import { CommandFault } from '#errors';
import { InteractionExit } from '#navigation';
import { publishStatus } from '#operation';
import { CommandValidationError } from '#validation';

import type {
  CommandOptions,
  Interaction,
  StatusUpdate,
} from '#command/contracts';
import type { WorkstationProfile } from '#core/profile';
import type {
  MachineOffer,
  ProviderDriver,
  WorkstationRecord,
} from '#drivers/contracts';
import type { SuppliedSelection } from '#input/selection';

/** what a resize needs to decide and apply */
export interface ResizeParams {
  /** authenticated provider hosting the workstation */
  provider: ProviderDriver;
  /** managed workstation selected for this run */
  workstation: WorkstationRecord;
  /** validated selection this run applies */
  profile: WorkstationProfile;
  /** values the run's flags and environment supply */
  supplied: SuppliedSelection;
  /** parsed setup flags */
  options: CommandOptions;
  /** optional inline prompts */
  interaction?: Interaction;
}

/**
 * moves the workstation to the smallest machine that meets the validated
 * minimums, but only when this run supplied a minimum: a run that supplies none
 * never changes the size. A provider that restarts the machine to resize it
 * is warned about first, and is not resized until the caller consents
 * @param params provider, workstation, validated selection and consent inputs
 * @returns the workstation as recorded after the resize, or unchanged when none applies
 * @throws {CommandValidationError} when a restart needs consent a non-interactive run has not given
 * @throws {InteractionExit} when the caller declines the restart
 */
export async function resizeWhenRequested(
  params: ResizeParams,
): Promise<WorkstationRecord> {
  const { provider, workstation, profile, supplied } = params;
  if (
    supplied.options.minCpus === undefined &&
    supplied.options.minMemoryGb === undefined
  ) {
    return workstation;
  }
  const offer = pickMachine(provider.machines, {
    cpus: profile.options.minCpus,
    memoryGb: profile.options.minMemoryGb,
  });
  if (!offer) {
    throw new CommandFault({
      code: 'INPUT',
      message: `${provider.displayName} offers no machine for ${profile.options.minCpus} CPUs and ${profile.options.minMemoryGb} GB`,
    });
  }
  if (isSameMachine(workstation.machine, offer)) {
    return workstation;
  }
  if (provider.capabilities.resizeRestarts) {
    await consentToRestart(params, offer);
  }

  return provider.resize(workstation, offer);
}

/**
 * warns that the resize restarts the machine and requires consent to go on
 * @param params provider, workstation and consent inputs
 * @param offer machine size the workstation moves to
 */
async function consentToRestart(
  params: ResizeParams,
  offer: MachineOffer,
): Promise<void> {
  const { workstation, options, interaction } = params;
  const warning: StatusUpdate = {
    kind: 'warning',
    message: `Resizing ${workstation.name} to ${describeMachine(offer)} restarts the machine to take effect; running sessions and processes stop`,
  };
  publishStatus(warning, interaction);
  if (options.yes) {
    return;
  }
  if (!interaction || options.nonInteractive) {
    throw new CommandValidationError({
      message: `${warning.message}; pass --yes to resize without asking`,
    });
  }
  const accepted = await interaction.confirm({
    message: `Restart ${workstation.name} to resize it to ${describeMachine(offer)}?`,
    defaultAnswer: false,
  });
  if (!accepted) {
    throw new InteractionExit('cancel');
  }
}

/**
 * names a machine size for messages
 * @param offer machine size
 * @returns the preset name, CPUs and memory
 */
function describeMachine(offer: MachineOffer): string {
  return `${offer.label} (${offer.cpus} CPUs, ${offer.memoryGb} GB)`;
}
