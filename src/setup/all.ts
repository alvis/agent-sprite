import { installManagedServices } from '#integrations/guest/runtime';
import { traceStage } from '#operation';
import {
  nativeConfigurationSteps,
  runNativeConfigurationSteps,
} from '#workstation/configuration';

import { setupNetwork } from './network.js';
import { setupPlugins } from './plugins.js';
import {
  setupEnvironment,
  setupGit,
  setupGithub,
  setupProxy,
  setupAgent,
  setupTools,
} from './sections.js';
import { exposeWhenServing } from './serving.js';

import type {
  AllSetupData,
  EnvironmentSetupData,
  GitSetupData,
  GithubSetupData,
  PluginsSetupData,
  ProxySetupData,
  NetworkSetupData,
  ToolsSetupData,
} from '#command/data';
import type { GuestChannel } from '#drivers/guest-channel';
import type { NativeConfigurationSteps } from '#workstation/configuration';

import type { SetupContext } from './context.js';

/**
 * reconciles all managed guest sections and verify current readiness
 * @param guest guest channel of the managed workstation
 * @param context full setup choices, prompts, and redaction values
 * @returns non-secret section outcomes after readiness succeeds
 */
export async function setupAll(
  guest: GuestChannel,
  context: SetupContext,
): Promise<AllSetupData> {
  const steps = nativeConfigurationSteps({
    mode: 'setup',
    initialInstallation: context.initialInstallation,
  });
  const configured = await configureSetupSections(guest, context, steps);
  const agent = await finalizeSetupAll(guest, context);

  return { ...configured, ...agent };
}

/**
 * Apply the context-specific full setup order through existing section owners.
 * @param guest guest channel of the managed workstation
 * @param context full setup choices and mutation state
 * @param steps context-specific full setup order
 * @returns completed native and service section outcomes
 */
async function configureSetupSections(
  guest: GuestChannel,
  context: SetupContext,
  steps: NativeConfigurationSteps,
): Promise<AllSetupData> {
  let tools!: ToolsSetupData;
  let network!: NetworkSetupData;
  let github: GithubSetupData | undefined;
  let git: GitSetupData | undefined;
  let proxy!: ProxySetupData;
  let environment: EnvironmentSetupData | undefined;
  let plugins: PluginsSetupData | undefined;
  const handlers = {
    tools: async (): Promise<void> => {
      tools = await setupTools(guest, {
        ...context,
        options: { ...context.options, update: true },
      });
    },
    network: async (): Promise<void> => {
      network = await setupNetwork(guest, context);
    },
    github: async (): Promise<void> => {
      if (context.options.github !== false) {
        github = await setupGithub(guest, context);
      }
    },
    git: async (): Promise<void> => {
      if (context.options.gitIdentity !== false) {
        git = await setupGit(guest, context);
      }
    },
    proxy: async (): Promise<void> => {
      proxy = await setupProxy(guest, context);
    },
    environment: async (): Promise<void> => {
      if (context.options.envFile) {
        environment = await setupEnvironment(guest, context);
      }
    },
    plugins: async (): Promise<void> => {
      if (context.options.plugins !== false) {
        plugins = await setupPlugins(guest, context);
      }
    },
    services: async (): Promise<void> => installServices(guest, context),
  };
  await runSetupPhases(steps, handlers);

  return {
    ...tools,
    ...network,
    ...github,
    ...git,
    ...proxy,
    ...environment,
    ...plugins,
  };
}

/**
 * installs the managed services; the tools phase has already installed the
 * selected release, which only a restarted agent loads, so the agent restarts
 * when this run changed the release channel
 * @param guest guest channel of the managed workstation
 * @param context full setup choices
 */
async function installServices(
  guest: GuestChannel,
  context: SetupContext,
): Promise<void> {
  await installManagedServices(guest, {
    isAgentRestarted: context.isReleaseChanged,
  });
}

/**
 * reports the real ordered setup phases without inventing skipped step work
 * @param steps selected native setup order
 * @param handlers actual section actions
 */
async function runSetupPhases(
  steps: NativeConfigurationSteps,
  handlers: Parameters<typeof runNativeConfigurationSteps>[1],
): Promise<void> {
  await traceStage('setup.native.preparation', async () =>
    runNativeConfigurationSteps(steps.preparation, handlers),
  );
  await traceStage('setup.native.configuration', async () =>
    runNativeConfigurationSteps(steps.configuration, handlers),
  );
  await traceStage('setup.native.completion', async () =>
    runNativeConfigurationSteps(steps.completion, handlers),
  );
}

/**
 * Verify services before exposure and mint pairing only when requested.
 * @param guest guest channel of the managed workstation
 * @param context selected setup options and pairing policy
 * @returns optional requested pairing outcome
 */
async function finalizeSetupAll(
  guest: GuestChannel,
  context: SetupContext,
): Promise<Awaited<ReturnType<typeof setupAgent>> | undefined> {
  // the configuration steps may have restarted the agent service
  await exposeWhenServing(guest, context);

  // the release was switched by the configuration steps, not by pairing
  return context.options.withPairCode
    ? setupAgent(guest, { ...context, isReleaseChanged: false })
    : undefined;
}
