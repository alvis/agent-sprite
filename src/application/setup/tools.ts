import { markInstallationReady } from '#application/installation/readiness';
import { CommandFault } from '#kernel/faults';
import { promptUnavailableDetail, traceStage } from '#kernel/operation';

import { installSetupPlan } from './installation';

import type { ComponentCounts, ToolsSetupData } from '#application/data';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { Interaction } from '#application/ports/interaction';
import type { UpdateStatus } from '#domain/observations/updates';

import type { SetupContext } from './context';

/** longest a forced update may take */
const UPDATE_LIMIT_MS = 3_600_000;

/**
 * refreshes managed developer tools on the guest: an update runs the setup
 * plan, which repairs what is missing, then the update gate, which upgrades
 * every recorded tool, while viewing recorded versions changes nothing
 * @param dependencies the guest mechanics
 * @param guest guest channel of the managed workstation
 * @param context parsed update flag, prompts, and mutation state
 * @returns tool update outcome
 */
export async function setupTools(
  dependencies: Pick<ApplicationDependencies, 'guest'>,
  guest: GuestChannel,
  context: SetupContext,
): Promise<ToolsSetupData> {
  const { options, interaction } = context;
  // a changed due interval was stored before this section ran;
  // with nothing else asked for and nobody to ask, that is the whole outcome
  if (context.persistsProfile && !options.update && !interaction) {
    return { tools: 'scheduled' };
  }
  if (!options.update && !interaction) {
    throw new CommandFault({
      code: 'USAGE',
      message: [
        'Non-interactive tools setup requires --update',
        promptUnavailableDetail(),
      ]
        .filter(Boolean)
        .join('. '),
    });
  }
  const action = options.update
    ? 'update'
    : await selectToolsAction(interaction!);
  if (action === 'versions') {
    const [environment, lastUpdate] = await Promise.all([
      dependencies.guest.environment.read(guest),
      dependencies.guest.environment.readUpdateStatus(guest),
    ]);

    return {
      tools: {
        status: 'recorded versions',
        tools: environment.tools,
        skipped: environment.setup.skipped,
        lastUpdate,
      },
    };
  }
  if (
    interaction &&
    !options.update &&
    !options.yes &&
    !(await interaction.confirm({
      message:
        'Install latest stable tools now? Running services are not restarted.',
    }))
  ) {
    return { tools: 'unchanged' };
  }
  interaction?.progress({
    stage: 'tools',
    message:
      'Installing latest stable tools in place; this may take several minutes',
  });
  await installSetupPlan(dependencies, context);
  await markInstallationReady(dependencies.guest, guest);
  const status = await forceUpdate(dependencies, guest, context);

  return status?.finishedAt
    ? { tools: 'updated', components: countOutcomes(status) }
    : { tools: 'updated' };
}

/**
 * runs the update gate whether or not an update is due, in the setup session,
 * timed as its own stage
 * @param dependencies the guest mechanics
 * @param guest guest channel of the managed workstation
 * @param context the setup session
 * @returns what the update recorded, when it recorded anything
 * @throws {CommandFault} when the gate could not record the update
 */
async function forceUpdate(
  dependencies: Pick<ApplicationDependencies, 'guest'>,
  guest: GuestChannel,
  context: Pick<SetupContext, 'connection'>,
): Promise<UpdateStatus | undefined> {
  const { exitCode } = await traceStage({
    stage: 'setup.update',
    action: async () =>
      context.connection.run({
        argv: [dependencies.guest.facts.updateGateCommand, '--force'],
        account: 'root',
        timeoutMs: UPDATE_LIMIT_MS,
      }),
    context: { succeeded: (result) => result.exitCode === 0 },
  });
  if (exitCode !== 0) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `The update gate exited with status ${String(exitCode)}; see ${dependencies.guest.facts.updateLog} on the guest`,
    });
  }

  return dependencies.guest.environment.readUpdateStatus(guest);
}

/**
 * summarizes an update as counts of current, untouched and failed tools
 * @param status what the update recorded
 * @returns how many tools are current, were skipped and failed
 */
function countOutcomes(status: UpdateStatus): ComponentCounts {
  const outcomes = status.tools.map(({ outcome }) => outcome);

  return {
    installed: outcomes.filter((outcome) => outcome === 'installed').length,
    skipped: outcomes.filter((outcome) => outcome === 'skipped').length,
    failed: outcomes.filter((outcome) => outcome === 'failed').length,
  };
}

/**
 * chooses recorded versions or an explicit tool mutation
 * @param interaction active managed-tools menu
 * @returns selected tools action
 */
async function selectToolsAction(interaction: Interaction): Promise<string> {
  return interaction.select(
    {
      message: 'Managed tools',
      description:
        'Viewing versions makes no changes. Updating installs latest stable tools in place and never restarts a running service.',
    },
    [
      {
        value: 'versions',
        label: 'View recorded installed versions',
        description:
          'Versions captured by the last successful installation/update',
      },
      {
        value: 'update',
        label: 'Update tools now',
        description:
          'May take several minutes; running services keep their current process',
      },
    ],
  );
}
