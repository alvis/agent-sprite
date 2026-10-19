import { awakeHookCommand } from '#application/catalog/awake';
import {
  configureHarnesses,
  harnessDrivers,
  proxyRoute,
} from '#application/catalog/harnesses';
import { pairAgent } from '#application/catalog/services';
import { resolveInputs } from '#application/input';
import { markInstallationReady } from '#application/installation/readiness';
import { selectedChannel } from '#domain/release-channels';
import { CommandFault } from '#kernel/faults';
import { PairingSecret } from '#kernel/pairing-secret';
import { Secret } from '#kernel/secret';

import { installSetupPlan } from './install';
import { missingSetupInputs } from './prepare';
import { exposeWhenServing } from './serving';

import type {
  AgentSetupData,
  GithubSetupData,
  GitSetupData,
  ProxySetupData,
  EnvironmentSetupData,
} from '#application/data';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { GuestChannel } from '#application/ports/guest-channel';

import type { SetupContext } from './context';

/**
 * installs persistent agent services, moves the agent to the release channel
 * this run selected, or mints a requested native pairing
 * @param dependencies the registered drivers, the guest mechanics
 * @param guest guest channel of the managed workstation
 * @param context pairing options, status reporter, and mutation state
 * @returns service or pairing outcome
 */
export async function setupAgent(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  guest: GuestChannel,
  context: SetupContext,
): Promise<AgentSetupData> {
  const { options, interaction, profile } = context;
  if (context.isReleaseChanged) {
    await switchAgentRelease(dependencies, guest, context);
  } else if (!options.withPairCode) {
    await installSetupPlan(dependencies, context);
    await markInstallationReady(dependencies.guest, guest);
  }
  if (!options.withPairCode) {
    return { service: 'configured', pairing: { status: 'not requested' } };
  }
  const pairing = await pairAgent(dependencies.registry, guest, profile.agent);
  interaction?.status({
    kind: 'success',
    message: `New ${dependencies.registry.agents[profile.agent].displayName} pairing expires ${pairing.expiresAt ?? 'per native policy'}`,
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
 * downgrade when the channel is older: the agent service is stopped first, so
 * the plan's service step starts it on that release, then the agent is waited
 * for to serve and exposed
 * @param dependencies the registered drivers, the guest mechanics
 * @param guest guest channel of the managed workstation
 * @param context selection already stored with the selected channel, prompts and mutation state
 */
async function switchAgentRelease(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  guest: GuestChannel,
  context: SetupContext,
): Promise<void> {
  const { interaction, mutation, profile } = context;
  const { displayName, releaseChannels, service } =
    dependencies.registry.agents[profile.agent];
  const channel = selectedChannel(
    releaseChannels,
    profile.options.agentRelease,
  );
  interaction?.progress({
    stage: 'agent',
    message: `Installing the ${channel?.id ?? 'selected'} release of ${displayName}; this may take several minutes`,
  });
  mutation.started = true;
  await stopService(guest, service.name);
  await installSetupPlan(dependencies, context);
  await markInstallationReady(dependencies.guest, guest);
  await exposeWhenServing(dependencies, guest, context);
}

/**
 * stops a service when it runs
 * @param guest guest channel of the managed workstation
 * @param name service name as the backend lists it
 * @throws {CommandFault} when the service reports a stop failure
 */
export async function stopService(
  guest: GuestChannel,
  name: string,
): Promise<void> {
  const services = await guest.services.list();
  if (
    services.some(
      (entry) => entry.name === name && entry.status === 'running',
    ) &&
    !(await guest.services.stop(name))
  ) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `The ${name} service reported a stop failure`,
    });
  }
}

/**
 * sets optional GitHub authentication for the agent and the provider shell accounts
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param guest guest channel of the managed workstation
 * @param context GitHub choices, prompts, and redaction values
 * @returns gitHub configuration outcome
 */
export async function setupGithub(
  dependencies: ApplicationDependencies,
  guest: GuestChannel,
  context: SetupContext,
): Promise<GithubSetupData> {
  const { options, interaction, mutation } = context;
  if (options.github === false) {
    return { github: 'preserved' };
  }
  const input = await resolveInputs(dependencies, {
    options,
    interaction,
    requirementSelection: ['githubToken'],
  });
  if (!input.githubToken) {
    return { github: 'skipped' };
  }
  mutation.started = true;
  await dependencies.guest.native.configureGithub(
    guest,
    Secret.fromHost('github', input.githubToken),
    {
      hostname: options.githubHost,
      shellAccounts:
        dependencies.registry.providers[context.profile.provider].shellAccounts,
    },
  );

  return { github: 'configured' };
}

/**
 * sets author and committer identity in the guest's Git configuration
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param guest guest channel of the managed workstation
 * @param context Git identity options, prompts, and mutation state
 * @returns git configuration outcome
 */
export async function setupGit(
  dependencies: ApplicationDependencies,
  guest: GuestChannel,
  context: SetupContext,
): Promise<GitSetupData> {
  const { options, interaction, mutation } = context;
  if (options.gitIdentity === false) {
    return { gitIdentity: 'preserved' };
  }
  const input = await resolveInputs(dependencies, {
    options,
    interaction,
    requirementSelection: ['gitIdentity'],
  });
  if (!input.gitIdentity && interaction && !input.missing.length) {
    return { gitIdentity: 'preserved' };
  }
  if (input.missing.length || !input.gitIdentity) {
    throw missingSetupInputs(input.missing);
  }
  mutation.started = true;
  await dependencies.guest.native.configureGit(guest, input.gitIdentity);

  return { gitIdentity: 'configured' };
}

/**
 * configures each selected harness against the selected CLIProxyAPI gateway
 * @param dependencies the registered drivers, the guest mechanics
 * @param guest guest channel of the managed workstation
 * @param context gateway choices, prompts, and redaction values
 * @returns non-secret gateway summary
 */
export async function setupProxy(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  guest: GuestChannel,
  context: SetupContext,
): Promise<ProxySetupData> {
  const { input, profile, mutation } = context;
  const { isProxyEnabled } = profile.options;
  await dependencies.guest.environment.assertProfile(guest, profile);
  if (isProxyEnabled && (!input.proxyUrl || !input.proxyApiKey)) {
    throw new Error('Validated CLIProxyAPI inputs were unavailable');
  }
  mutation.started = true;
  const drivers = harnessDrivers(dependencies.registry, profile.harnesses);
  await configureHarnesses(guest, {
    drivers,
    proxy: proxyRoute({
      enabled: isProxyEnabled,
      gateway: dependencies.registry.gateways.cliproxyapi,
      url: input.proxyUrl,
      apiKey: input.proxyApiKey,
      drivers,
    }),
    hub: dependencies.guest.hub,
    awakeHook: awakeHookCommand(dependencies.guest.facts),
  });

  return {
    proxy: isProxyEnabled
      ? { status: 'configured', baseUrl: input.proxyUrl }
      : { status: 'disabled' },
  };
}

/**
 * loads and writes a selected runtime environment file, asking for its path
 * in a terminal and skipping the section when no file is selected and no
 * prompt can ask for one
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param guest guest channel of the managed workstation
 * @param context environment choice, prompts, and redaction values
 * @returns names of configured runtime variables, or the skipped section
 */
export async function setupEnvironment(
  dependencies: ApplicationDependencies,
  guest: GuestChannel,
  context: SetupContext,
): Promise<EnvironmentSetupData> {
  const { options, interaction, mutation } = context;
  const envPath =
    options.envFile ??
    (interaction && !options.nonInteractive
      ? await interaction.input({
          message: 'Runtime env file path',
          required: true,
        })
      : undefined);
  if (!envPath) {
    return { runtimeEnvironment: { status: 'skipped' } };
  }
  const input = await resolveInputs(dependencies, {
    options: { ...options, envFile: envPath },
    requirementSelection: [],
  });
  mutation.started = true;
  await dependencies.guest.native.configureRuntimeEnv(guest, input.runtimeEnv);

  return {
    runtimeEnvironment: {
      status: 'configured',
      names: Object.keys(input.runtimeEnv),
    },
  };
}
