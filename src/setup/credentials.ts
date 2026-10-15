import { networksWithInputs } from '#core/networks';
import { CommandFault } from '#errors';
import { saveLocalCredential } from '#integrations/credentials';
import { rememberSecret } from '#utilities/redaction';

import type { CommandResult } from '#command';
import type { CommandOptions, Interaction } from '#command/contracts';
import type { LocalCredentialData } from '#command/data';
import type { NetworkWithInputs } from '#core/networks';
import type { CredentialStoreLocation } from '#integrations/credentials';

/**
 * replaces a shared caller-side network management key only after explicit consent
 * @param interaction local secret and confirmation prompts
 * @param options parsed consent options
 * @param location optional exact real store for an isolated caller
 * @returns non-secret storage outcome without a workstation-scoped identity
 */
export async function replaceNetworkCredential(
  interaction: Interaction,
  options: CommandOptions = {},
  location?: CredentialStoreLocation,
): Promise<LocalCredentialData> {
  const network = await selectCredentialNetwork(interaction);
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
  const storage = await saveLocalCredential(
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

/**
 * completes the shared local credential action without inventing a machine identity
 * @param interaction explicit local consent and secret prompts
 * @param options parsed consent options
 * @param location optional exact real store for an isolated caller
 * @returns machine-free setup result
 */
export async function setupLocalCredential(
  interaction?: Interaction,
  options: CommandOptions = {},
  location?: CredentialStoreLocation,
): Promise<CommandResult> {
  if (!interaction) {
    throw new CommandFault({
      code: 'USAGE',
      message: 'Local credential replacement requires interactive mode',
    });
  }

  return {
    command: 'setup',
    ok: true,
    data: await replaceNetworkCredential(interaction, options, location),
  };
}

/**
 * picks the network whose saved key is replaced, asking only among several
 * @param interaction local prompts
 * @returns the network driver
 */
async function selectCredentialNetwork(
  interaction: Interaction,
): Promise<NetworkWithInputs> {
  const networks = networksWithInputs();
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

  return networks.find((network) => network.id === id) ?? only;
}
