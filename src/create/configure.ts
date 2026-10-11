import { assertGuestIntegrations } from '#integrations/guest/manifest';
import {
  configureTailscale,
  installGuestTools,
  installManagedServices,
} from '#integrations/guest/runtime';
import { withGuestTransaction } from '#integrations/guest/transaction';
import {
  applyClaudePlugins,
  applyCodexPlugins,
  configureClaude,
  configureCodex,
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

import type { Sprite } from '@fly/sprites';

import type { Interaction } from '#command/contracts';
import type { GitIdentity } from '#input/types';
import type { GuestIntegrations } from '#integrations/guest/types';
import type { HarnessPluginActions } from '#plugins';
import type { NativeConfigurationStep } from '#workstation/configuration';

interface NewWorkstationConfiguration {
  integrations: GuestIntegrations;
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
 * installs tools, route the tailnet, configure harnesses, and start services
 * @param sprite exact newly created private Sprite
 * @param configuration confirmed guest setup values
 * @param interaction optional progress boundary
 */
export async function configureNewWorkstation(
  sprite: Sprite,
  configuration: NewWorkstationConfiguration,
  interaction?: Interaction,
): Promise<void> {
  const { integrations } = configuration;
  const steps = nativeConfigurationSteps({ mode: 'create' });
  await runNativeConfigurationSteps(steps.preparation, {
    tools: async () => {
      interaction?.progress({
        stage: 'tools',
        message: 'Installing managed developer tools',
      });
      await traceStage('create.tools', async () =>
        installGuestTools(sprite, integrations),
      );
    },
    tailscale: async () => {
      if (!integrations.tailscale) {
        return;
      }
      interaction?.progress({
        stage: 'tailscale',
        message: integrations.exitNode
          ? 'Configuring Tailscale exit-node routing'
          : 'Configuring Tailscale connectivity',
      });
      await traceStage('create.tailscale', async () =>
        configureTailscale(
          sprite,
          configuration.authKey,
          configuration.exitNode,
        ),
      );
    },
  });
  interaction?.progress({
    stage: 'configuration',
    message: 'Writing native harness and account configuration',
  });
  await traceStage('create.configuration', async () =>
    configureNative(sprite, configuration, steps.configuration),
  );
  await runNativeConfigurationSteps(steps.completion, {
    services: async () => {
      interaction?.progress({
        stage: 'services',
        message: 'Installing persistent T3 and maintenance services',
      });
      await traceStage('create.services', async () =>
        installManagedServices(sprite),
      );
    },
  });
}

/**
 * applies selected native account, routing, and plugin configuration
 * @param sprite exact managed guest
 * @param configuration selected non-secret and transient secret inputs
 * @param steps ordered native configuration steps
 */
async function configureNative(
  sprite: Sprite,
  configuration: NewWorkstationConfiguration,
  steps: readonly NativeConfigurationStep[],
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    const { integrations, githubToken, githubHost } = configuration;
    await runNativeConfigurationSteps(steps, {
      assert: async () => assertGuestIntegrations(sprite, integrations),
      environment: async () =>
        configureRuntimeEnv(sprite, configuration.runtimeEnv),
      github: async () => {
        if (githubToken) {
          await configureGithub(sprite, githubToken, githubHost);
        }
      },
      git: async () => {
        if (configuration.gitIdentity) {
          await configureGit(sprite, configuration.gitIdentity);
        }
      },
      proxy: async () => {
        await configureClaude(
          sprite,
          integrations.cliproxyapi ? configuration.proxyUrl : undefined,
          integrations.cliproxyapi ? configuration.proxyApiKey : undefined,
        );
        await configureCodex(
          sprite,
          integrations.cliproxyapi ? configuration.proxyUrl : undefined,
          integrations.cliproxyapi ? configuration.proxyApiKey : undefined,
        );
      },
      plugins: async () => {
        if (hasActions(configuration.plugins.claude)) {
          await applyClaudePlugins(sprite, configuration.plugins.claude);
        }
        if (hasActions(configuration.plugins.codex)) {
          await applyCodexPlugins(sprite, configuration.plugins.codex);
        }
      },
    });
  });
}
