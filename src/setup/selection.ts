import { returnOnBack, withBackNavigation } from '#navigation';
import { hasExplicitPluginActions } from '#plugins';

import type {
  CommandOptions,
  Interaction,
  InteractionChoice,
  SetupSection,
} from '#command/contracts';

const SETUP_SECTIONS: Array<InteractionChoice<SetupSection>> = [
  {
    value: 't3',
    label: 'T3 Code',
    description:
      'Configure the T3 service; pair via the workstation action menu',
  },
  {
    value: 'tailscale',
    label: 'Tailscale',
    description: 'Workstation networking or the shared key on this computer',
  },
  {
    value: 'github',
    label: 'GitHub authentication',
    description: 'Configure the native GitHub CLI credential',
  },
  {
    value: 'git',
    label: 'Git / Jujutsu identity',
    description: 'Configure author and committer names and emails',
  },
  {
    value: 'proxy',
    label: 'CLIProxyAPI',
    description: 'Configure Claude and Codex routing to your existing hub',
  },
  {
    value: 'env',
    label: 'Environment variables',
    description: 'Configure guest runtime variables',
  },
  {
    value: 'plugins',
    label: 'Native plugins',
    description: 'Manage Claude and Codex marketplaces and plugins',
  },
  {
    value: 'tools',
    label: 'Managed tools',
    description:
      'View recorded versions or explicitly update and restart services',
  },
  {
    value: 'all',
    label: 'Full setup / recovery',
    description: 'Update tools, restart services and configure every section',
  },
];

/** selected guest section or separately scoped caller-side credential action */
export type SetupSelection = SetupSection | 'tailscale-credential';

/**
 * selects a setup section from flags or an inline prompt
 * @param options parsed setup options
 * @param interaction optional inline prompts
 * @returns the requested section
 */
export async function selectSetupSection(
  options: CommandOptions,
  interaction?: Interaction,
): Promise<SetupSelection> {
  const explicitPlugins = hasExplicitPluginActions(options);
  if (explicitPlugins && options.section && options.section !== 'plugins') {
    throw new Error(
      'Explicit plugin actions conflict with the selected setup section',
    );
  }
  if (options.section) {
    return options.section;
  }
  if (options.withT3PairCode) {
    return 't3';
  }
  if (explicitPlugins) {
    return 'plugins';
  }
  if (!interaction || options.nonInteractive) {
    throw new Error(
      'Non-interactive setup requires --section or explicit plugin actions',
    );
  }

  for (;;) {
    const section = await interaction.select(
      { message: 'Choose setup section' },
      SETUP_SECTIONS,
    );
    if (section !== 'tailscale') {
      return section;
    }
    const selected = await selectTailscaleAction(interaction);
    if (selected !== undefined) {
      return selected;
    }
  }
}

/**
 * Select guest networking or caller-side credential replacement.
 * @param interaction current section menu
 * @returns selected action or back to sections
 */
async function selectTailscaleAction(
  interaction: Interaction,
): Promise<SetupSelection | undefined> {
  return returnOnBack(async () =>
    withBackNavigation(interaction, 'back to sections').select<SetupSelection>(
      {
        message: 'Tailscale',
        description:
          'Guest networking and the key saved on this computer are separate.',
      },
      [
        {
          value: 'tailscale',
          label: 'Configure workstation networking',
          description:
            'Tailnet connection and optional exit-node routing on the Sprite',
        },
        {
          value: 'tailscale-credential',
          label: 'Replace saved API key on this computer',
          description:
            'Shared local management key; does not change this Sprite',
        },
      ],
    ),
  );
}
