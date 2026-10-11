import { CommandFault } from '#errors';
import { resolveInputs } from '#input';
import { assertGuestIntegrations } from '#integrations/guest/manifest';
import {
  installGuestTools,
  installManagedServices,
  readGuestManifest,
} from '#integrations/guest/runtime';
import { withGuestTransaction } from '#integrations/guest/transaction';
import {
  configureClaude,
  configureCodex,
  configureGit,
  configureGithub,
  configureRuntimeEnv,
  pairT3,
} from '#integrations/native';
import { promptUnavailableDetail } from '#operation';
import { PairingSecret } from '#utilities/pairing-secret';

import type { Sprite } from '@fly/sprites';

import type { Interaction } from '#command/contracts';
import type {
  T3SetupData,
  GithubSetupData,
  GitSetupData,
  ProxySetupData,
  EnvironmentSetupData,
  ToolsSetupData,
} from '#command/data';

import type { SetupContext } from './context.js';

/**
 * installs persistent T3 services or mint a requested native pairing
 * @param sprite exact managed Sprite
 * @param context pairing options, status reporter, and mutation state
 * @returns service or pairing outcome
 */
export async function setupT3(
  sprite: Sprite,
  context: SetupContext,
): Promise<T3SetupData> {
  const { options, interaction, mutation } = context;
  if (!options.withT3PairCode) {
    mutation.started = true;
    await installManagedServices(sprite);

    return { service: 'configured', pairing: { status: 'not requested' } };
  }
  const pairing = await pairT3(sprite);
  interaction?.status({
    kind: 'success',
    message: `New T3 pairing expires ${pairing.expiresAt ?? 'per native policy'}`,
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
 * sets optional GitHub authentication for T3 and the default provider shell
 * @param sprite exact managed Sprite
 * @param context GitHub choices, prompts, and redaction values
 * @returns gitHub configuration outcome
 */
export async function setupGithub(
  sprite: Sprite,
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
  await configureGithub(sprite, input.githubToken, options.githubHost);

  return { github: 'configured' };
}

/**
 * sets author and committer identity in the guest's Git configuration
 * @param sprite exact managed Sprite
 * @param context Git identity options, prompts, and mutation state
 * @returns git configuration outcome
 */
export async function setupGit(
  sprite: Sprite,
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
  await configureGit(sprite, input.gitIdentity);

  return { gitIdentity: 'configured' };
}

/**
 * configures Claude and Codex against the selected CLIProxyAPI gateway
 * @param sprite exact managed Sprite
 * @param context gateway choices, prompts, and redaction values
 * @returns non-secret gateway summary
 */
export async function setupProxy(
  sprite: Sprite,
  context: SetupContext,
): Promise<ProxySetupData> {
  return withGuestTransaction(sprite, async () => {
    const { input, integrations, mutation } = context;
    await assertGuestIntegrations(sprite, integrations);
    if (integrations.cliproxyapi && (!input.proxyUrl || !input.proxyApiKey)) {
      throw new Error('Validated CLIProxyAPI inputs were unavailable');
    }
    mutation.started = true;
    await configureClaude(
      sprite,
      integrations.cliproxyapi ? input.proxyUrl : undefined,
      integrations.cliproxyapi ? input.proxyApiKey : undefined,
    );
    await configureCodex(
      sprite,
      integrations.cliproxyapi ? input.proxyUrl : undefined,
      integrations.cliproxyapi ? input.proxyApiKey : undefined,
    );

    return {
      proxy: integrations.cliproxyapi
        ? { status: 'configured', baseUrl: input.proxyUrl }
        : { status: 'disabled' },
    };
  });
}

/**
 * loads and write a selected runtime environment file
 * @param sprite exact managed Sprite
 * @param context environment choice, prompts, and redaction values
 * @returns names of configured runtime variables
 */
export async function setupEnvironment(
  sprite: Sprite,
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
  await configureRuntimeEnv(sprite, input.runtimeEnv);

  return {
    runtimeEnvironment: {
      status: 'configured',
      names: Object.keys(input.runtimeEnv),
    },
  };
}

/**
 * refreshes managed developer tools on the guest
 * @param sprite exact managed Sprite
 * @param context parsed update flag, prompts, and mutation state
 * @returns tool update outcome
 */
export async function setupTools(
  sprite: Sprite,
  context: SetupContext,
): Promise<ToolsSetupData> {
  const { options, interaction, integrations, mutation } = context;
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
    const manifest = await readGuestManifest(sprite);

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
        'Install latest stable tools and restart managed T3/Tailscale services now?',
    }))
  ) {
    return { tools: 'unchanged' };
  }
  interaction?.progress({
    stage: 'tools',
    message:
      'Installing latest stable tools and restarting managed services; this may take several minutes',
  });
  mutation.started = true;
  await installGuestTools(sprite, integrations);

  return { tools: 'updated' };
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
        'Viewing versions makes no changes. Updating installs latest stable tools and restarts managed services.',
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
          'May take several minutes; restarts T3 and enabled Tailscale',
      },
    ],
  );
}
