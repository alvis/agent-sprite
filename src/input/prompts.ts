import { catalog } from '#core/catalog';
import { networkDriver } from '#core/networks';
import { enteredCredentialProblem } from '#core/preflight';
import { CLIPROXYAPI_INPUTS } from '#drivers/shared/cliproxyapi/inputs';
import { CommandFault } from '#errors';
import { saveLocalCredential } from '#integrations/credentials';
import { validateMachineName } from '#machine';
import { rememberSecret } from '#utilities/redaction';

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
  name: ManagementCredentialName,
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
  const network = networkDriver(input.profile.network).inputs;
  if (network && required.includes('networkAccount')) {
    input.networkAccount ??= await interaction.input({
      message: network.account.prompt,
      required: true,
    });
  }
  if (network && required.includes('exitNode')) {
    input.exitNode ??= await interaction.input({
      message: network.exitNode.prompt,
      required: true,
    });
  }
  if (required.includes('proxyUrl')) {
    input.proxyUrl ??= await interaction.input({
      message: CLIPROXYAPI_INPUTS.baseUrl.prompt,
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
  const { credential } =
    catalog.providers[input.profile.provider].prerequisites;
  if (required.includes('providerToken') && !input.providerToken) {
    const { provider } = input.profile;
    input.providerToken = await interaction.secret({
      message: credential.label,
      description: `It needs ${credential.scope}. ${credential.obtain}`,
      required: true,
      validate: (value) => enteredCredentialProblem(provider, value),
    });
    rememberSecret(input.providerToken);
    // saved only after the provider accepts it; see retainEnteredProviderToken
    input.isProviderTokenEntered = true;
    input.sources[credential.environment] = 'the entered token';
  }
  const network = networkDriver(input.profile.network).inputs;
  if (
    network &&
    required.includes('networkEnrollment') &&
    !input.networkKey &&
    !input.enrollmentKey
  ) {
    input.networkKey = await interaction.secret({
      message: network.management.prompt,
      required: true,
    });
    await retainPromptedCredential(
      input,
      { name: network.management.store, value: input.networkKey },
      context,
    );
  }
  if (required.includes('proxyApiKey')) {
    input.proxyApiKey ??= await interaction.secret({
      message: CLIPROXYAPI_INPUTS.apiKey.prompt,
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

/**
 * offers to save a provider credential entered in this run, once the provider
 * has accepted it, and records the storage outcome
 * @param input resolved workflow inputs holding the entered credential
 * @param context consent prompt and local retention policy
 * @param context.interaction consent prompt
 * @param context.options parsed consent options
 */
export async function retainEnteredProviderToken(
  input: ResolvedInputs,
  context: { interaction?: Interaction; options: CommandOptions },
): Promise<void> {
  const { interaction, options } = context;
  if (!input.isProviderTokenEntered || !interaction || options.nonInteractive) {
    return;
  }
  const { credential } =
    catalog.providers[input.profile.provider].prerequisites;
  await retainPromptedCredential(
    input,
    { name: credential.store, value: input.providerToken },
    { options, interaction, required: [] },
  );
  input.isProviderTokenEntered = false;
}
