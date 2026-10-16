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
import { assertGuestProfile } from '#integrations/guest/environment/store';
import { markInstallationReady } from '#integrations/guest/install';
import { Secret } from '#integrations/guest/session/secret';
import {
  configureGit,
  configureGithub,
  configureRuntimeEnv,
} from '#integrations/native/git';
import { promptUnavailableDetail } from '#operation';
import { PairingSecret } from '#utilities/pairing-secret';

import { installSetupPlan } from './install';
import { exposeWhenServing } from './serving';

import type {
  AgentSetupData,
  GithubSetupData,
  GitSetupData,
  ProxySetupData,
  EnvironmentSetupData,
} from '#command/data';
import type { GuestChannel } from '#drivers/guest-channel';

import type { SetupContext } from './context';

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
  const { options, interaction, profile } = context;
  if (context.isReleaseChanged) {
    await switchAgentRelease(guest, context);
  } else if (!options.withPairCode) {
    await installSetupPlan(context);
    await markInstallationReady(guest);
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
 * downgrade when the channel is older: the agent service is stopped first, so
 * the plan's service step starts it on that release, then the agent is waited
 * for to serve and exposed
 * @param guest guest channel of the managed workstation
 * @param context selection already stored with the selected channel, prompts and mutation state
 */
async function switchAgentRelease(
  guest: GuestChannel,
  context: SetupContext,
): Promise<void> {
  const { interaction, mutation, profile } = context;
  const { displayName, releaseChannels, service } =
    catalog.agents[profile.agent];
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
  await installSetupPlan(context);
  await markInstallationReady(guest);
  await exposeWhenServing(guest, context);
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
  await configureGithub(guest, Secret.fromHost('github', input.githubToken), {
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
    options.envFile ??
    (interaction && !options.nonInteractive
      ? await interaction.input({
          message: 'Runtime env file path',
          required: true,
        })
      : undefined);
  if (!envPath) {
    throw new CommandFault({
      code: 'INPUT',
      message: [
        'Runtime env setup requires --env-file',
        promptUnavailableDetail(),
      ]
        .filter(Boolean)
        .join('. '),
    });
  }
  const input = await resolveInputs(
    { ...options, envFile: envPath },
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
