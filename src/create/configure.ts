import { catalog } from '#core/catalog';
import {
  configureHarnesses,
  harnessDrivers,
  proxyRoute,
} from '#core/harnesses';
import { networkDriver } from '#core/networks';
import { networkIdentityRecorder } from '#integrations/guest/environment-store';
import {
  installWorkstation,
  markInstallationReady,
} from '#integrations/guest/install';
import { writeWorkstationLabel } from '#integrations/guest/label';
import { Secret } from '#integrations/guest/session/secret';
import {
  configureGit,
  configureGithub,
  configureRuntimeEnv,
} from '#integrations/native';
import { traceStage } from '#operation';
import { hasActions } from '#plugins';

import type { Interaction } from '#command/contracts';
import type { WorkstationProfile } from '#core/profile';
import type { ProviderDriver } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type { GitIdentity } from '#input/types';
import type { SetupConnection } from '#integrations/guest/connection';
import type { HarnessPluginActions } from '#plugins';

interface NewWorkstationConfiguration {
  /** workstation name, used as the network device hostname and the agent's environment label */
  hostname: string;
  /** validated selection the workstation is created with */
  profile: WorkstationProfile;
  authKey?: Secret;
  exitNode?: string;
  proxyUrl?: string;
  proxyApiKey?: string;
  githubToken?: string;
  githubHost?: string;
  gitIdentity?: GitIdentity;
  runtimeEnv: Record<string, string>;
  plugins: HarnessPluginActions;
}

/**
 * installs the workstation through its setup plan, enrolling the network and
 * writing the native harness and account configuration before the services
 * start, since the agent's launcher reads its runtime environment and
 * committer only as it starts, then records the installation as ready
 * @param provider the provider the workstation runs on
 * @param session the root setup session of the newly created workstation and its progress boundary
 * @param session.connection the root setup session
 * @param session.interaction optional progress boundary
 * @param configuration confirmed guest setup values
 * @returns the guest channel the configuration ran over
 */
export async function configureNewWorkstation(
  provider: ProviderDriver,
  session: { connection: SetupConnection; interaction?: Interaction },
  configuration: NewWorkstationConfiguration,
): Promise<GuestChannel> {
  const { connection, interaction } = session;
  const { profile } = configuration;
  interaction?.progress({
    stage: 'tools',
    message: 'Installing the guest environment and managed developer tools',
  });
  await traceStage('create.tools', async () =>
    installWorkstation({
      provider,
      connection,
      profile,
      interaction,
      beforeServices: async (guest) =>
        enrolAndConfigure(guest, configuration, interaction),
    }),
  );
  const guest = await connection.guest();
  await writeWorkstationLabel(guest, configuration.hostname);
  await markInstallationReady(guest);

  return guest;
}

/**
 * enrols the selected network, then writes the native harness and account
 * configuration
 * @param guest guest channel of the managed workstation
 * @param configuration confirmed guest setup values
 * @param interaction optional progress boundary
 */
async function enrolAndConfigure(
  guest: GuestChannel,
  configuration: NewWorkstationConfiguration,
  interaction?: Interaction,
): Promise<void> {
  const { profile } = configuration;
  const network = networkDriver(profile.network);
  if (network.daemon) {
    interaction?.progress({
      stage: 'network',
      message: profile.options.isExitNodeEnabled
        ? `Configuring ${network.displayName} exit-node routing`
        : `Configuring ${network.displayName} connectivity`,
    });
  }
  await traceStage('create.network', async () =>
    network.enroll(guest, {
      hostname: configuration.hostname,
      credential: configuration.authKey,
      exitNode: configuration.exitNode,
      recordIdentity: networkIdentityRecorder(guest, network.id),
    }),
  );
  interaction?.progress({
    stage: 'configuration',
    message: 'Writing native harness and account configuration',
  });
  await traceStage('create.configuration', async () =>
    configureNative(guest, configuration),
  );
}

/**
 * applies selected native account, routing, and plugin configuration
 * @param guest guest channel of the managed workstation
 * @param configuration selected non-secret and transient secret inputs
 */
async function configureNative(
  guest: GuestChannel,
  configuration: NewWorkstationConfiguration,
): Promise<void> {
  const { profile, githubToken, githubHost } = configuration;
  const drivers = harnessDrivers(profile.harnesses);
  await configureRuntimeEnv(guest, configuration.runtimeEnv);
  if (githubToken) {
    await configureGithub(guest, Secret.fromHost('github', githubToken), {
      hostname: githubHost,
      shellAccounts: catalog.providers[profile.provider].shellAccounts,
    });
  }
  if (configuration.gitIdentity) {
    await configureGit(guest, configuration.gitIdentity);
  }
  await configureHarnesses(guest, {
    drivers,
    proxy: proxyRoute({
      enabled: profile.options.isProxyEnabled,
      url: configuration.proxyUrl,
      apiKey: configuration.proxyApiKey,
      drivers,
    }),
  });
  for (const driver of drivers) {
    if (hasActions(configuration.plugins[driver.id])) {
      await driver.plugins.apply(guest, configuration.plugins[driver.id]);
    }
  }
}
