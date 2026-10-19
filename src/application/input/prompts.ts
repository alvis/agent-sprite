import { networkDriver } from '#application/catalog/networks';
import { validateMachineName } from '#application/machine';
import { enteredCredentialProblem } from '#domain/prerequisites';
import { CommandFault } from '#kernel/faults';
import { rememberSecret } from '#kernel/redaction';

import type { CommandOptions } from '#application/contracts';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { Interaction } from '#application/ports/interaction';

import type {
  CredentialSaveResult,
  CredentialStoreLocation,
  ManagementCredentialName,
} from '#domain/credentials';

import type { RequiredInput, ResolvedInputs } from './types';

interface PromptContext {
  options: CommandOptions;
  interaction?: Interaction;
  required: readonly RequiredInput[];
  credentialStore?: CredentialStoreLocation;
}

interface ActivePromptContext extends PromptContext {
  interaction: Interaction;
}

/** the named inputs of retain management credential */
export interface RetainManagementCredentialParams {
  /** management service holding the new credential */
  name: ManagementCredentialName;
  /** secret value entered by the caller */
  value: string;
  /** inline consent prompt */
  interaction: Interaction;
  /** parsed consent options */
  options: CommandOptions;
  /** optional exact real store for an isolated caller */
  credentialStore?: CredentialStoreLocation;
}

/**
 * asks before retaining a newly entered local management credential
 * @param dependencies what this computer provides
 * @param params the call's inputs: name, value, interaction, options, credentialStore
 * @returns observed backend and fallback reason when retention was accepted
 */
export async function retainManagementCredential(
  dependencies: Pick<ApplicationDependencies, 'host'>,
  params: RetainManagementCredentialParams,
): Promise<CredentialSaveResult | undefined> {
  const { name, value, credentialStore } = params;
  const { interaction, options } = params;
  const retain = options.yes
    ? true
    : await interaction.confirm({
        message: `Save the ${name} management credential in the OS credential store (or a protected file if unavailable)?`,
      });
  if (retain) {
    const saved = await dependencies.host.credentials.save(name, value, {
      consent: true,
      allowProtectedFileFallback: true,
      location: credentialStore,
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
 * @param dependencies the registered drivers, what this computer provides
 * @param input resolved values to complete in place
 * @param context parsed options and inline prompt boundary
 */
export async function resolveInteractiveInputs(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  input: ResolvedInputs,
  context: PromptContext,
): Promise<void> {
  const { options, interaction, required } = context;
  if (!interaction || options.nonInteractive) {
    return;
  }
  await promptPublicInputs(dependencies, { input, required, interaction });
  await promptSecrets(dependencies, input, {
    options,
    required,
    interaction,
    credentialStore: context.credentialStore,
  });
}

/** the named inputs of prompt public inputs */
interface PromptPublicInputsParams {
  /** values to complete in place */
  input: ResolvedInputs;
  /** inputs needed by the selected workflow */
  required: readonly RequiredInput[];
  /** inline text prompts */
  interaction: Interaction;
}

/**
 * asks for missing non-secret create and setup values
 * @param dependencies the registered drivers
 * @param params the call's inputs: input, required, interaction
 */
async function promptPublicInputs(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  params: PromptPublicInputsParams,
): Promise<void> {
  const { input, required, interaction } = params;
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
  const network = networkDriver(
    dependencies.registry,
    input.profile.network,
  ).inputs;
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
      message: dependencies.registry.gateways.cliproxyapi.inputs.baseUrl.prompt,
      required: true,
    });
  }
}

/**
 * prompts only for missing management and guest credentials
 * @param dependencies the registered drivers, what this computer provides
 * @param input values to complete in place
 * @param context local credential policy and active secret prompts
 */
async function promptSecrets(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  input: ResolvedInputs,
  context: ActivePromptContext,
): Promise<void> {
  const { required, interaction } = context;
  const { credential } =
    dependencies.registry.providers[input.profile.provider].prerequisites;
  if (required.includes('providerToken') && !input.providerToken) {
    const { provider } = input.profile;
    input.providerToken = await interaction.secret({
      message: credential.label,
      description: `It needs ${credential.scope}. ${credential.obtain}`,
      required: true,
      validate: (value) =>
        enteredCredentialProblem(dependencies.registry, provider, value),
    });
    rememberSecret(input.providerToken);
    // saved only after the provider accepts it; see retainEnteredProviderToken
    input.isProviderTokenEntered = true;
    input.sources[credential.environment] = 'the entered token';
  }
  const network = networkDriver(
    dependencies.registry,
    input.profile.network,
  ).inputs;
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
    await retainPromptedCredential(dependencies, {
      input,
      credential: { name: network.management.store, value: input.networkKey },
      context,
    });
  }
  if (required.includes('proxyApiKey')) {
    input.proxyApiKey ??= await interaction.secret({
      message: dependencies.registry.gateways.cliproxyapi.inputs.apiKey.prompt,
      required: true,
    });
  }
  rememberSecret(input.proxyApiKey);
}

/** the named inputs of retain prompted credential */
interface RetainPromptedCredentialParams {
  /** resolved workflow inputs */
  input: ResolvedInputs;
  /** management identity and newly entered secret */
  credential: { name: ManagementCredentialName; value: string | undefined };
  /** prompt and local retention policy */
  context: ActivePromptContext;
}

/**
 * Records a prompted secret and its consented local storage outcome.
 * @param dependencies what this computer provides
 * @param params the call's inputs: input, credential, context
 */
async function retainPromptedCredential(
  dependencies: Pick<ApplicationDependencies, 'host'>,
  params: RetainPromptedCredentialParams,
): Promise<void> {
  const { input, credential, context } = params;
  const { name, value } = credential;
  rememberSecret(value);
  if (!value || context.options.localCredentials === false) {
    return;
  }
  const retained = await retainManagementCredential(dependencies, {
    name,
    value,
    ...context,
  });
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
 * @param dependencies the registered drivers, what this computer provides
 * @param input resolved workflow inputs holding the entered credential
 * @param context consent prompt and local retention policy
 * @param context.interaction consent prompt
 * @param context.options parsed consent options
 */
export async function retainEnteredProviderToken(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  input: ResolvedInputs,
  context: { interaction?: Interaction; options: CommandOptions },
): Promise<void> {
  const { interaction, options } = context;
  if (!input.isProviderTokenEntered || !interaction || options.nonInteractive) {
    return;
  }
  const { credential } =
    dependencies.registry.providers[input.profile.provider].prerequisites;
  await retainPromptedCredential(dependencies, {
    input,
    credential: { name: credential.store, value: input.providerToken },
    context: { options, interaction, required: [] },
  });
  input.isProviderTokenEntered = false;
}
