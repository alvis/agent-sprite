import { networksWithInputs } from '#application/catalog/networks';
import { CommandFault } from '#kernel/faults';
import { rememberSecret } from '#kernel/redaction';

import type { NetworkWithInputs } from '#application/catalog/networks';
import type { CommandOptions } from '#application/contracts';
import type { LocalCredentialData } from '#application/data';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { Interaction } from '#application/ports/interaction';
import type { CommandResult } from '#application/result';
import type { CredentialStoreLocation } from '#domain/credentials';

/** the named inputs of replace network credential */
export interface ReplaceNetworkCredentialParams {
  /** local secret and confirmation prompts */
  interaction: Interaction;
  /** parsed consent options */
  options?: CommandOptions;
  /** optional exact real store for an isolated caller */
  location?: CredentialStoreLocation;
}

/**
 * replaces a shared caller-side network management key only after explicit consent
 * @param dependencies the registered drivers, what this computer provides
 * @param params the call's inputs: interaction, options, location
 * @returns non-secret storage outcome without a workstation-scoped identity
 */
export async function replaceNetworkCredential(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  params: ReplaceNetworkCredentialParams,
): Promise<LocalCredentialData> {
  const { interaction, options = {}, location } = params;
  const network = await selectCredentialNetwork(dependencies, interaction);
  const accepted = options.yes
    ? true
    : await interaction.confirm({
        message: `Replace the saved ${network.displayName} API key on this computer?`,
        description:
          'Shared by all workstations. Does not change guest networking. Explicit env/flag credentials still take precedence.',
      });
  if (!accepted) {
    return {
      localCredential: {
        status: 'unchanged',
        scope: 'this computer; all workstations',
      },
    };
  }
  const replacement = await interaction.secret({
    message: `New local ${network.inputs.management.prompt}`,
    required: true,
  });
  rememberSecret(replacement);
  const storage = await dependencies.host.credentials.save(
    network.inputs.management.store,
    replacement,
    {
      consent: true,
      allowProtectedFileFallback: true,
      location,
    },
  );

  return {
    localCredential: {
      status: 'replaced',
      scope: 'this computer; all workstations',
      storage: storage.storage,
      fallbackReason: storage.fallbackReason,
    },
  };
}

/** the named inputs of setup local credential */
export interface SetupLocalCredentialParams {
  /** explicit local consent and secret prompts */
  interaction?: Interaction;
  /** parsed consent options */
  options?: CommandOptions;
  /** optional exact real store for an isolated caller */
  location?: CredentialStoreLocation;
}

/**
 * completes the shared local credential action without inventing a machine identity
 * @param dependencies the registered drivers, what this computer provides
 * @param params the call's inputs: interaction, options, location
 * @returns machine-free setup result
 */
export async function setupLocalCredential(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  params: SetupLocalCredentialParams,
): Promise<CommandResult> {
  const { interaction, options = {}, location } = params;
  if (!interaction) {
    throw new CommandFault({
      code: 'USAGE',
      message: 'Local credential replacement requires interactive mode',
    });
  }

  return {
    command: 'setup',
    ok: true,
    data: await replaceNetworkCredential(dependencies, {
      interaction,
      options,
      location,
    }),
  };
}

/**
 * picks the network whose saved key is replaced, asking only among several
 * @param dependencies the registered drivers
 * @param interaction local prompts
 * @returns the network driver
 */
async function selectCredentialNetwork(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  interaction: Interaction,
): Promise<NetworkWithInputs> {
  const networks = networksWithInputs(dependencies.registry);
  const [only] = networks;
  if (!only) {
    throw new CommandFault({
      code: 'USAGE',
      message: 'No registered network keeps a local management credential',
    });
  }
  if (networks.length === 1) {
    return only;
  }
  const id = await interaction.select(
    { message: 'Network' },
    networks.map(({ id: value, displayName }) => ({
      value,
      label: displayName,
    })),
  );

  return networks.find((network) => network.id === id)!;
}
