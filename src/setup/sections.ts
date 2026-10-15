import { catalog } from '#core/catalog';
import {
  configureHarnesses,
  harnessDrivers,
  proxyRoute,
} from '#core/harnesses';
import { selectedChannel } from '#core/release-channels';
import { pairAgent } from '#core/services';
import { CommandFault } from '#errors';
import { resolveInputs } from '#input';
import { assertGuestProfile } from '#integrations/guest/manifest';
import {
  installGuestTools,
  installManagedServices,
  readGuestManifest,
} from '#integrations/guest/runtime';
import { withGuestTransaction } from '#integrations/guest/transaction';
import {
  configureGit,
  configureGithub,
  configureRuntimeEnv,
} from '#integrations/native';
import { promptUnavailableDetail } from '#operation';
import { PairingSecret } from '#utilities/pairing-secret';

import { exposeWhenServing } from './serving.js';

import type { Interaction } from '#command/contracts';
import type {
  AgentSetupData,
  ComponentCounts,
  GithubSetupData,
  GitSetupData,
  ProxySetupData,
  EnvironmentSetupData,
  ToolsSetupData,
} from '#command/data';
import type { GuestChannel } from '#drivers/guest-channel';
import type { GuestManifest } from '#integrations/guest/runtime';

import type { SetupContext } from './context.js';

/**
 * installs persistent agent services, moves the agent to the release channel
 * this run selected, or mints a requested native pairing
 * @param guest guest channel of the managed workstation
 * @param context pairing options, status reporter, and mutation state
 * @returns service or pairing outcome
 */
export async function setupAgent(
  guest: GuestChannel,
  context: SetupContext,
): Promise<AgentSetupData> {
  const { options, interaction, mutation, profile } = context;
  if (context.isReleaseChanged) {
    await switchAgentRelease(guest, context);
  } else if (!options.withPairCode) {
    mutation.started = true;
    await installManagedServices(guest);
  }
  if (!options.withPairCode) {
    return { service: 'configured', pairing: { status: 'not requested' } };
  }
  const pairing = await pairAgent(guest, profile.agent);
  interaction?.status({
    kind: 'success',
    message: `New ${catalog.agents[profile.agent].displayName} pairing expires ${pairing.expiresAt ?? 'per native policy'}`,
  });

  return {
    pairing: {
      status: 'created',
      expiresAt: pairing.expiresAt,
      token: new PairingSecret({ token: pairing.token }),
    },
  };
}

/**
 * installs the release the selected channel currently publishes, which is a
 * downgrade when the channel is older, restarts the agent service so it runs
 * that release, then waits for the agent to serve and exposes it
 * @param guest guest channel of the managed workstation
 * @param context selection already stored with the selected channel, prompts and mutation state
 */
async function switchAgentRelease(
  guest: GuestChannel,
  context: SetupContext,
): Promise<void> {
  const { interaction, mutation, profile } = context;
  const { displayName, releaseChannels } = catalog.agents[profile.agent];
  const channel = selectedChannel(
    releaseChannels,
    profile.options.agentRelease,
  );
  interaction?.progress({
    stage: 'agent',
    message: `Installing the ${channel?.id ?? 'selected'} release of ${displayName}; this may take several minutes`,
  });
  mutation.started = true;
  await installGuestTools(guest, profile);
  await installManagedServices(guest, { isAgentRestarted: true });
  await exposeWhenServing(guest, context);
}

/**
 * sets optional GitHub authentication for the agent and the provider shell accounts
 * @param guest guest channel of the managed workstation
 * @param context GitHub choices, prompts, and redaction values
 * @returns gitHub configuration outcome
 */
export async function setupGithub(
  guest: GuestChannel,
  context: SetupContext,
): Promise<GithubSetupData> {
  const { options, interaction, mutation } = context;
  if (options.github === false) {
    return { github: 'preserved' };
  }
  const input = await resolveInputs(options, interaction, ['githubToken']);
  if (!input.githubToken) {
    return { github: 'skipped' };
  }
  mutation.started = true;
  await configureGithub(guest, input.githubToken, {
    hostname: options.githubHost,
    shellAccounts: catalog.providers[context.profile.provider].shellAccounts,
  });

  return { github: 'configured' };
}

/**
 * sets author and committer identity in the guest's Git configuration
 * @param guest guest channel of the managed workstation
 * @param context Git identity options, prompts, and mutation state
 * @returns git configuration outcome
 */
export async function setupGit(
  guest: GuestChannel,
  context: SetupContext,
): Promise<GitSetupData> {
  const { options, interaction, mutation } = context;
  if (options.gitIdentity === false) {
    return { gitIdentity: 'preserved' };
  }
  const input = await resolveInputs(options, interaction, ['gitIdentity']);
  if (!input.gitIdentity && interaction && !input.missing.length) {
    return { gitIdentity: 'preserved' };
  }
  if (input.missing.length || !input.gitIdentity) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Missing: ${input.missing.join(', ')}`,
    });
  }
  mutation.started = true;
  await configureGit(guest, input.gitIdentity);

  return { gitIdentity: 'configured' };
}

/**
 * configures each selected harness against the selected CLIProxyAPI gateway
 * @param guest guest channel of the managed workstation
 * @param context gateway choices, prompts, and redaction values
 * @returns non-secret gateway summary
 */
export async function setupProxy(
  guest: GuestChannel,
  context: SetupContext,
): Promise<ProxySetupData> {
  return withGuestTransaction(guest, async () => {
    const { input, profile, mutation } = context;
    const { isProxyEnabled } = profile.options;
    await assertGuestProfile(guest, profile);
    if (isProxyEnabled && (!input.proxyUrl || !input.proxyApiKey)) {
      throw new Error('Validated CLIProxyAPI inputs were unavailable');
    }
    mutation.started = true;
    const drivers = harnessDrivers(profile.harnesses);
    await configureHarnesses(guest, {
      drivers,
      proxy: proxyRoute({
        enabled: isProxyEnabled,
        url: input.proxyUrl,
        apiKey: input.proxyApiKey,
        drivers,
      }),
    });

    return {
      proxy: isProxyEnabled
        ? { status: 'configured', baseUrl: input.proxyUrl }
        : { status: 'disabled' },
    };
  });
}

/**
 * loads and write a selected runtime environment file
 * @param guest guest channel of the managed workstation
 * @param context environment choice, prompts, and redaction values
 * @returns names of configured runtime variables
 */
export async function setupEnvironment(
  guest: GuestChannel,
  context: SetupContext,
): Promise<EnvironmentSetupData> {
  const { options, interaction, mutation } = context;
  const envPath =
    options.env ??
    (interaction && !options.nonInteractive
      ? await interaction.input({
          message: 'Runtime env file path',
          required: true,
        })
      : undefined);
  if (!envPath) {
    throw new CommandFault({
      code: 'INPUT',
      message: ['Runtime env setup requires --env', promptUnavailableDetail()]
        .filter(Boolean)
        .join('. '),
    });
  }
  const input = await resolveInputs(
    { ...options, env: envPath },
    undefined,
    [],
  );
  mutation.started = true;
  await configureRuntimeEnv(guest, input.runtimeEnv);

  return {
    runtimeEnvironment: {
      status: 'configured',
      names: Object.keys(input.runtimeEnv),
    },
  };
}

/**
 * refreshes managed developer tools on the guest; an update also redeploys the
 * update gate and entry and rewrites the interval file from the stored profile,
 * while viewing recorded versions changes nothing
 * @param guest guest channel of the managed workstation
 * @param context parsed update flag, prompts, and mutation state
 * @returns tool update outcome
 */
export async function setupTools(
  guest: GuestChannel,
  context: SetupContext,
): Promise<ToolsSetupData> {
  const { options, interaction, profile, mutation } = context;
  // a changed interval was stored with its schedule before this section ran;
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
    const manifest = await readGuestManifest(guest);

    return {
      tools: {
        status: 'recorded versions',
        installedVersions: manifest.installedVersions,
        lastSuccessfulUpdate: manifest.lastSuccessfulUpdate,
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
  mutation.started = true;
  const outcomes = await installGuestTools(guest, profile);

  return outcomes
    ? { tools: 'updated', components: countOutcomes(outcomes) }
    : { tools: 'updated' };
}

/**
 * summarizes an install run as counts of changed and already-current components
 * @param outcomes what the run did to each component
 * @returns how many components were installed and how many were skipped
 */
function countOutcomes(
  outcomes: NonNullable<GuestManifest['componentOutcomes']>,
): ComponentCounts {
  const statuses = Object.values(outcomes).map(({ status }) => status);

  return {
    installed: statuses.filter((status) => status === 'installed').length,
    skipped: statuses.filter((status) => status === 'skipped').length,
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
