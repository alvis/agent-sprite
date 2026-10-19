import { retainManagementCredential } from '#application/input/prompts';
import { resolveProviderCredential } from '#application/input/provider-credential';
import { enteredCredentialProblem } from '#domain/prerequisites';
import { rememberSecret } from '#kernel/redaction';

import type {
  CommandRequest,
  WorkstationCommandParams,
} from '#application/contracts';
import type { ProviderCredential } from '#application/input/provider-credential';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { Interaction } from '#application/ports/interaction';
import type { CommandResult } from '#application/result';
import type { ProviderId } from '#domain/ids';

/** a provider credential, and whether the caller entered it in this run */
export interface CommandCredential extends ProviderCredential {
  /** entered at the prompt, so not yet saved anywhere */
  isEntered?: boolean;
}

/** what deciding whether to save an entered credential needs */
interface RetentionContext {
  request: CommandRequest;
  provider: ProviderId;
  credential: CommandCredential;
  interaction?: Interaction;
}

/**
 * offers to save an entered credential only once the command succeeded, which
 * proves the provider accepted it, and carries the outcome into the result
 * @param dependencies the registered drivers, what this computer provides
 * @param result authenticated command result
 * @param context command, provider, entered credential and consent prompt
 * @returns the result with non-secret storage metadata when the credential was saved
 */
export async function retainAcceptedCredential(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  result: CommandResult,
  context: RetentionContext,
): Promise<CommandResult> {
  const { request, provider, credential, interaction } = context;
  if (
    !result.ok ||
    !credential.isEntered ||
    !credential.token ||
    !interaction ||
    request.options.localCredentials === false
  ) {
    return result;
  }
  const retainedCredential = await retainManagementCredential(dependencies, {
    name: dependencies.registry.providers[provider].prerequisites.credential
      .store,
    value: credential.token,
    interaction,
    options: request.options,
  });

  return retainedCredential ? { ...result, retainedCredential } : result;
}

/**
 * resolves the selected provider's credential, asking only in interactive mode
 * @param dependencies the registered drivers, what this computer provides
 * @param params the call's inputs: request, provider, interaction
 * @returns the credential and its source, if available
 */
export async function resolveCommandCredential(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  params: WorkstationCommandParams<ProviderId>,
): Promise<CommandCredential> {
  const { request, provider, interaction } = params;
  const resolved = await resolveProviderCredential(dependencies, {
    options: request.options,
    provider,
    selection: {
      reference: request.options.providerTokenSource,
    },
  });

  return resolved.token
    ? resolved
    : enterCommandCredential(dependencies, { request, provider, interaction });
}

/**
 * asks for a provider credential in interactive mode, asking again while the
 * entered value is a credential shape the provider refuses
 * @param dependencies the registered drivers
 * @param params the call's inputs: request, provider, interaction
 * @returns the entered credential, or none in non-interactive mode
 */
export async function enterCommandCredential(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  params: WorkstationCommandParams<ProviderId>,
): Promise<CommandCredential> {
  const { request, provider, interaction } = params;
  if (!interaction || request.options.nonInteractive) {
    return {};
  }
  const { credential } =
    dependencies.registry.providers[provider].prerequisites;
  const token = await interaction.secret({
    message: credential.label,
    description: `It needs ${credential.scope}. ${credential.obtain}`,
    required: true,
    validate: (value) =>
      enteredCredentialProblem(dependencies.registry, provider, value),
  });
  rememberSecret(token);

  return { token, source: 'the entered token', isEntered: true };
}
