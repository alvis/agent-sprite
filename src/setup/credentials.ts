import { CommandFault } from '#errors';
import { saveLocalCredential } from '#integrations/credentials';
import { rememberSecret } from '#utilities/redaction';

import type { CommandResult } from '#command';
import type { CommandOptions, Interaction } from '#command/contracts';
import type { LocalCredentialData } from '#command/data';
import type { CredentialStoreLocation } from '#integrations/credentials';

/**
 * replaces the shared caller-side Tailscale key only after explicit consent
 * @param interaction local secret and confirmation prompts
 * @param options parsed consent options
 * @param location optional exact real store for an isolated caller
 * @returns non-secret storage outcome without a workstation-scoped identity
 */
export async function replaceTailscaleCredential(
  interaction: Interaction,
  options: CommandOptions = {},
  location?: CredentialStoreLocation,
): Promise<LocalCredentialData> {
  const accepted = options.yes
    ? true
    : await interaction.confirm({
        message: 'Replace the saved Tailscale API key on this computer?',
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
    message: 'New local Tailscale management API key',
    required: true,
  });
  rememberSecret(replacement);
  const storage = await saveLocalCredential('tailscale', replacement, {
    consent: true,
    allowProtectedFileFallback: true,
    location,
  });

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
    data: await replaceTailscaleCredential(interaction, options, location),
  };
}
