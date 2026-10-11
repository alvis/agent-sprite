import {
  installManagedServices,
  inspectGuest,
} from '#integrations/guest/runtime';
import { setSpritePublic } from '#integrations/sprites';
import { traceStage } from '#operation';
import { ReadinessFault, assessReadiness } from '#readiness';
import {
  nativeConfigurationSteps,
  runNativeConfigurationSteps,
} from '#workstation/configuration';

import { setupPlugins } from './plugins.js';
import {
  setupEnvironment,
  setupGit,
  setupGithub,
  setupProxy,
  setupT3,
  setupTools,
} from './sections.js';
import { setupTailscale } from './tailscale.js';

import type { Sprite } from '@fly/sprites';

import type {
  AllSetupData,
  EnvironmentSetupData,
  GitSetupData,
  GithubSetupData,
  PluginsSetupData,
  ProxySetupData,
  TailscaleSetupData,
  ToolsSetupData,
} from '#command/data';
import type { NativeConfigurationSteps } from '#workstation/configuration';

import type { SetupContext } from './context.js';

/**
 * reconciles all managed guest sections and verify current readiness
 * @param sprite exact managed Sprite
 * @param context full setup choices, prompts, and redaction values
 * @returns non-secret section outcomes after readiness succeeds
 */
export async function setupAll(
  sprite: Sprite,
  context: SetupContext,
): Promise<AllSetupData> {
  const steps = nativeConfigurationSteps({
    mode: 'setup',
    initialInstallation: context.initialInstallation,
  });
  const configured = await configureSetupSections(sprite, context, steps);
  const t3 = await finalizeSetupAll(sprite, context);

  return { ...configured, ...t3 };
}

/**
 * Apply the context-specific full setup order through existing section owners.
 * @param sprite exact managed Sprite
 * @param context full setup choices and mutation state
 * @param steps context-specific full setup order
 * @returns completed native and service section outcomes
 */
async function configureSetupSections(
  sprite: Sprite,
  context: SetupContext,
  steps: NativeConfigurationSteps,
): Promise<AllSetupData> {
  let tools!: ToolsSetupData;
  let tailscale!: TailscaleSetupData;
  let github: GithubSetupData | undefined;
  let git: GitSetupData | undefined;
  let proxy!: ProxySetupData;
  let environment: EnvironmentSetupData | undefined;
  let plugins: PluginsSetupData | undefined;
  const handlers = {
    tools: async (): Promise<void> => {
      tools = await setupTools(sprite, {
        ...context,
        options: { ...context.options, update: true },
      });
    },
    tailscale: async (): Promise<void> => {
      tailscale = await setupTailscale(sprite, context);
    },
    github: async (): Promise<void> => {
      if (context.options.github !== false) {
        github = await setupGithub(sprite, context);
      }
    },
    git: async (): Promise<void> => {
      if (context.options.gitIdentity !== false) {
        git = await setupGit(sprite, context);
      }
    },
    proxy: async (): Promise<void> => {
      proxy = await setupProxy(sprite, context);
    },
    environment: async (): Promise<void> => {
      if (context.options.env) {
        environment = await setupEnvironment(sprite, context);
      }
    },
    plugins: async (): Promise<void> => {
      if (context.options.plugins !== false) {
        plugins = await setupPlugins(sprite, context);
      }
    },
    services: async (): Promise<void> => installManagedServices(sprite),
  };
  await runSetupPhases(steps, handlers);

  return {
    ...tools,
    ...tailscale,
    ...github,
    ...git,
    ...proxy,
    ...environment,
    ...plugins,
  };
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
 * @param sprite exact managed Sprite
 * @param context selected setup options and pairing policy
 * @returns optional requested pairing outcome
 */
async function finalizeSetupAll(
  sprite: Sprite,
  context: SetupContext,
): Promise<Awaited<ReturnType<typeof setupT3>> | undefined> {
  const inspection = await traceStage('setup.readiness', async () =>
    inspectGuest(sprite),
  );
  const readiness = assessReadiness(inspection);
  if (!readiness.ready) {
    throw new ReadinessFault(readiness);
  }
  await setSpritePublic(sprite);

  return context.options.withT3PairCode ? setupT3(sprite, context) : undefined;
}
