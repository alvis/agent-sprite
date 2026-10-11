import { CommandFault } from '#errors';
import { saveLocalCredential } from '#integrations/credentials';
import { validateMachineName } from '#machine';
import { rememberSecret } from '#utilities/redaction';

import { spritesTokenPromptDescription } from './token-guidance.js';

import type { CommandOptions, Interaction } from '#command/contracts';

import type {
  CredentialSaveResult,
  CredentialStoreLocation,
  ManagementCredentialName,
} from '#integrations/credentials';

import type { RequiredInput, ResolvedInputs } from './types.js';

interface PromptContext {
  options: CommandOptions;
  interaction?: Interaction;
  required: readonly RequiredInput[];
  credentialStore?: CredentialStoreLocation;
}

interface ActivePromptContext extends PromptContext {
  interaction: Interaction;
}

/**
 * asks before retaining a newly entered local management credential
 * @param name management service holding the new credential
 * @param value secret value entered by the caller
 * @param context inline consent prompt and parsed options
 * @param context.interaction inline consent prompt
 * @param context.options parsed consent options
 * @param context.credentialStore optional exact real store for an isolated caller
 * @returns observed backend and fallback reason when retention was accepted
 */
export async function retainManagementCredential(
  name: 'sprites' | 'tailscale',
  value: string,
  context: {
    interaction: Interaction;
    options: CommandOptions;
    credentialStore?: CredentialStoreLocation;
  },
): Promise<CredentialSaveResult | undefined> {
  const { interaction, options } = context;
  const retain = options.yes
    ? true
    : await interaction.confirm({
        message: `Save the ${name} management credential in the OS credential store (or a protected file if unavailable)?`,
      });
  if (retain) {
    const saved = await saveLocalCredential(name, value, {
      consent: true,
      allowProtectedFileFallback: true,
      location: context.credentialStore,
    });
    const fallbackText = saved.fallbackReason
      ? ` (${saved.fallbackReason})`
      : '';
    interaction.status({
      kind: saved.fallbackReason ? 'warning' : 'success',
      message: `${name} management credential saved in ${saved.storage}${fallbackText}.`,
    });

    return saved;
  }

  return undefined;
}

/**
 * prompts for missing values only in interactive mode
 * @param input resolved values to complete in place
 * @param context parsed options and inline prompt boundary
 */
export async function resolveInteractiveInputs(
  input: ResolvedInputs,
  context: PromptContext,
): Promise<void> {
  const { options, interaction, required } = context;
  if (!interaction || options.nonInteractive) {
    return;
  }
  await promptPublicInputs(input, required, interaction);
  await promptSecrets(input, {
    options,
    required,
    interaction,
    credentialStore: context.credentialStore,
  });
}

/**
 * asks for missing non-secret create and setup values
 * @param input values to complete in place
 * @param required inputs needed by the selected workflow
 * @param interaction inline text prompts
 */
async function promptPublicInputs(
  input: ResolvedInputs,
  required: readonly RequiredInput[],
  interaction: Interaction,
): Promise<void> {
  if (required.includes('name')) {
    input.name ??= await interaction.input({
      message: 'Workstation name',
      required: true,
      validate: (name) => {
        try {
          validateMachineName(name);
        } catch (error) {
          if (error instanceof CommandFault) {
            return error.message;
          }
          throw error;
        }

        return undefined;
      },
    });
  }
  if (required.includes('tailnet')) {
    input.tailnet ??= await interaction.input({
      message:
        'Tailscale tailnet (API ID, .ts.net domain, or bare DNS subdomain)',
      required: true,
    });
  }
  if (required.includes('exitNode')) {
    input.exitNode ??= await interaction.input({
      message: 'Home exit node',
      required: true,
    });
  }
  if (required.includes('proxyUrl')) {
    input.proxyUrl ??= await interaction.input({
      message: 'CLIProxyAPI base URL',
      required: true,
    });
  }
}

/**
 * prompts only for missing management and guest credentials
 * @param input values to complete in place
 * @param context local credential policy and active secret prompts
 */
async function promptSecrets(
  input: ResolvedInputs,
  context: ActivePromptContext,
): Promise<void> {
  const { required, interaction } = context;
  if (required.includes('spritesToken') && !input.spritesToken) {
    input.spritesToken = await interaction.secret({
      message: 'Sprites API token',
      description: spritesTokenPromptDescription,
      required: true,
    });
    await retainPromptedCredential(
      input,
      { name: 'sprites', value: input.spritesToken },
      context,
    );
  }
  if (
    required.includes('tailscaleEnrollment') &&
    !input.tailscaleApiKey &&
    !input.tailscaleAuthKey
  ) {
    input.tailscaleApiKey = await interaction.secret({
      message: 'Tailscale management API key',
      required: true,
    });
    await retainPromptedCredential(
      input,
      { name: 'tailscale', value: input.tailscaleApiKey },
      context,
    );
  }
  if (required.includes('proxyApiKey')) {
    input.proxyApiKey ??= await interaction.secret({
      message: 'CLIProxyAPI client key',
      required: true,
    });
  }
  rememberSecret(input.proxyApiKey);
}

/**
 * Records a prompted secret and its consented local storage outcome.
 * @param input resolved workflow inputs
 * @param credential management identity and newly entered secret
 * @param credential.name selected management account
 * @param credential.value newly entered secret, if present
 * @param context prompt and local retention policy
 */
async function retainPromptedCredential(
  input: ResolvedInputs,
  credential: { name: ManagementCredentialName; value: string | undefined },
  context: ActivePromptContext,
): Promise<void> {
  const { name, value } = credential;
  rememberSecret(value);
  if (!value || context.options.localCredentials === false) {
    return;
  }
  const retained = await retainManagementCredential(name, value, context);
  if (retained) {
    input.retainedCredentials = {
      ...input.retainedCredentials,
      [name]: retained,
    };
  }
}
