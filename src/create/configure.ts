import { catalog } from '#core/catalog';
import {
  configureHarnesses,
  harnessDrivers,
  proxyRoute,
} from '#core/harnesses';
import { networkDriver } from '#core/networks';
import { writeWorkstationLabel } from '#integrations/guest/label';
import {
  assertGuestProfile,
  readGuestManifest,
  networkIdentityRecorder,
} from '#integrations/guest/manifest';
import {
  installGuestTools,
  installManagedServices,
} from '#integrations/guest/runtime';
import { withGuestTransaction } from '#integrations/guest/transaction';
import {
  configureGit,
  configureGithub,
  configureRuntimeEnv,
} from '#integrations/native';
import { traceStage } from '#operation';
import { hasActions } from '#plugins';
import {
  nativeConfigurationSteps,
  runNativeConfigurationSteps,
} from '#workstation/configuration';

import type { Interaction } from '#command/contracts';
import type { WorkstationProfile } from '#core/profile';
import type { GuestChannel } from '#drivers/guest-channel';
import type { GitIdentity } from '#input/types';
import type { HarnessPluginActions } from '#plugins';
import type { NativeConfigurationStep } from '#workstation/configuration';

interface NewWorkstationConfiguration {
  /** workstation name, used as the network device hostname and the agent's environment label */
  hostname: string;
  /** validated selection the workstation is created with */
  profile: WorkstationProfile;
  authKey?: string;
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
 * installs tools, route the network, configure harnesses, and start services
 * @param guest guest channel of the newly created private workstation
 * @param configuration confirmed guest setup values
 * @param interaction optional progress boundary
 */
export async function configureNewWorkstation(
  guest: GuestChannel,
  configuration: NewWorkstationConfiguration,
  interaction?: Interaction,
): Promise<void> {
  const { profile } = configuration;
  const network = networkDriver(profile.network);
  const steps = nativeConfigurationSteps({ mode: 'create' });
  await runNativeConfigurationSteps(steps.preparation, {
    tools: async () => {
      interaction?.progress({
        stage: 'tools',
        message: 'Installing managed developer tools',
      });
      await traceStage('create.tools', async () =>
        installGuestTools(guest, profile),
      );
    },
    network: async () => {
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
    },
  });
  interaction?.progress({
    stage: 'configuration',
    message: 'Writing native harness and account configuration',
  });
  await traceStage('create.configuration', async () =>
    configureNative(guest, configuration, steps.configuration),
  );
  await runNativeConfigurationSteps(steps.completion, {
    services: async () => {
      interaction?.progress({
        stage: 'services',
        message: `Installing persistent ${catalog.agents[profile.agent].displayName} and maintenance services`,
      });
      await traceStage('create.services', async () => {
        await writeWorkstationLabel(guest, configuration.hostname);
        await installManagedServices(guest);
      });
    },
  });
}

/**
 * applies selected native account, routing, and plugin configuration
 * @param guest guest channel of the managed workstation
 * @param configuration selected non-secret and transient secret inputs
 * @param steps ordered native configuration steps
 */
async function configureNative(
  guest: GuestChannel,
  configuration: NewWorkstationConfiguration,
  steps: readonly NativeConfigurationStep[],
): Promise<void> {
  await withGuestTransaction(guest, async () => {
    const { profile, githubToken, githubHost } = configuration;
    const drivers = harnessDrivers(
      (await readGuestManifest(guest)).profile.harnesses,
    );
    await runNativeConfigurationSteps(steps, {
      assert: async () => assertGuestProfile(guest, profile),
      environment: async () =>
        configureRuntimeEnv(guest, configuration.runtimeEnv),
      github: async () => {
        if (githubToken) {
          await configureGithub(guest, githubToken, {
            hostname: githubHost,
            shellAccounts: catalog.providers[profile.provider].shellAccounts,
          });
        }
      },
      git: async () => {
        if (configuration.gitIdentity) {
          await configureGit(guest, configuration.gitIdentity);
        }
      },
      proxy: async () => {
        await configureHarnesses(guest, {
          drivers,
          proxy: proxyRoute({
            enabled: profile.options.isProxyEnabled,
            url: configuration.proxyUrl,
            apiKey: configuration.proxyApiKey,
            drivers,
          }),
        });
      },
      plugins: async () => {
        for (const driver of drivers) {
          if (hasActions(configuration.plugins[driver.id])) {
            await driver.plugins.apply(guest, configuration.plugins[driver.id]);
          }
        }
      },
    });
  });
}
