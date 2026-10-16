import { catalog, DEFAULT_SELECTION } from '#core/catalog';
import { providerIds } from '#core/ids';
import {
  enteredCredentialProblem,
  prerequisiteDetails,
  providerPreflight,
} from '#core/preflight';
import { bindProvider } from '#core/providers';
import { createWorkstation } from '#create';
import { commandError } from '#errors';
import { retainManagementCredential } from '#input/prompts';
import { resolveProviderCredential } from '#input/provider-credential';
import { doctorWorkstation, listWorkstations, showWorkstation } from '#inspect';
import {
  currentOperation,
  cancellationReason,
  checkOperation,
  withOperation,
  promptUnavailableDetail,
} from '#operation';
import { setupWorkstation } from '#setup';
import { terminateWorkstation } from '#terminate';
import { rememberSecret } from '#utilities/redaction';
import { validateCommandRequest } from '#validation';

import { chooseWorkstationAction } from './workstation/actions.js';
import {
  locateProvider,
  providerAvailability,
  skippedProvider,
} from './workstation/providers.js';

import type { CommandResult } from '#command';
import type { CommandRequest, Interaction } from '#command/contracts';
import type { ProviderId } from '#core/catalog';
import type { ProviderDriver } from '#drivers/contracts';
import type { PrerequisiteProblem } from '#drivers/providers/prerequisites';
import type { ProviderCredential } from '#input/provider-credential';
import type { OperationContext } from '#operation';

/**
 * dispatches one workstation request without starting the CLI or printing its result
 * @param request command, options and optional machine selection
 * @param interaction optional prompts, status and progress boundary
 * @param operation optional explicit caller-owned cancellation scope
 * @returns the structured command result with resolved errors redacted
 * @example
 * const result = await runCommand({
 *   command: 'list',
 *   options: { envFile: '.env', nonInteractive: true },
 * });
 */
export async function runCommand(
  request: CommandRequest,
  interaction?: Interaction,
  operation?: OperationContext,
): Promise<CommandResult> {
  try {
    if (operation) {
      return await withOperation(operation, async () =>
        runCommand(request, interaction),
      );
    }
    checkOperation();
    currentOperation()?.select(request.command);
    validateCommandRequest(request, Boolean(interaction));
    if (request.command === 'create') {
      return await createWorkstation(request, interaction);
    }
    if (request.command === 'list') {
      return await listAvailableProviders(request, interaction);
    }
    const provider =
      request.options.provider ??
      (await locateProvider(request, interaction)) ??
      DEFAULT_SELECTION.provider;
    const credential = await resolveCommandCredential(
      request,
      provider,
      interaction,
    );
    const problems = await providerPreflight(provider, credential);
    if (!credential.token || problems.length > 0) {
      return prerequisiteFailure(request, problems);
    }
    const result = await dispatchAuthenticated(
      request,
      bindProvider(provider, credential.token),
      interaction,
    );

    return await retainAcceptedCredential(result, {
      request,
      provider,
      credential,
      interaction,
    });
  } catch (error) {
    return commandFailureResult(
      error,
      operation ?? currentOperation(),
      request,
    );
  }
}

/**
 * Builds a failure without dropping bounded recovery details or exact identity.
 * @param error primary rejection
 * @param context current invocation, if any
 * @param request selected command
 * @returns typed failure result
 */
function commandFailureResult(
  error: unknown,
  context: OperationContext | undefined,
  request: CommandRequest,
): CommandResult {
  const failure = commandError(
    context?.signal.aborted ? cancellationReason() : error,
  );
  const machine = context?.target?.name ?? request.machine;

  return {
    command: context?.command ?? request.command,
    ok: false,
    error: {
      ...failure,
      machine,
      machineId: context?.target?.id,
      details:
        failure.code === 'CANCELLED' && machine
          ? [
              ...(failure.details ?? []),
              `Inspect: open-agent show ${JSON.stringify(machine)} --inspect`,
              'Remote work may be unfinished; inspect before retrying mutations.',
            ]
          : failure.details,
    },
  };
}

/** a provider credential, and whether the caller entered it in this run */
interface CommandCredential extends ProviderCredential {
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
 * @param result authenticated command result
 * @param context command, provider, entered credential and consent prompt
 * @returns the result with non-secret storage metadata when the credential was saved
 */
async function retainAcceptedCredential(
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
  const retainedCredential = await retainManagementCredential(
    catalog.providers[provider].prerequisites.credential.store,
    credential.token,
    { interaction, options: request.options },
  );

  return retainedCredential ? { ...result, retainedCredential } : result;
}

/**
 * reports every missing or misconfigured provider prerequisite at once
 * @param request parsed command
 * @param problems problems the provider preflight found
 * @returns a typed INPUT failure before any provider call
 */
function prerequisiteFailure(
  request: CommandRequest,
  problems: readonly PrerequisiteProblem[],
): CommandResult {
  const promptHint = promptUnavailableDetail();

  return {
    command: request.command,
    ok: false,
    error: {
      code: 'INPUT',
      message: 'Provider prerequisites are missing or misconfigured',
      details: [
        ...prerequisiteDetails(problems),
        ...(promptHint ? [promptHint] : []),
      ],
    },
  };
}

/**
 * lists workstations on every provider whose credential is available, so a
 * failing provider is reported as unavailable rather than empty
 * @param request parsed list command
 * @param interaction optional secret prompt when no provider has a credential
 * @returns merged workstations and unavailable providers
 */
async function listAvailableProviders(
  request: CommandRequest,
  interaction?: Interaction,
): Promise<CommandResult> {
  const { options } = request;
  // an explicit source names the credential of the selected provider only
  const references = new Map<ProviderId, string>(
    options.providerTokenSource
      ? [
          [
            options.provider ?? DEFAULT_SELECTION.provider,
            options.providerTokenSource,
          ],
        ]
      : [],
  );
  const found = await Promise.all(
    providerIds().map(async (id) => ({
      id,
      credential: await resolveProviderCredential(options, id, {
        reference: references.get(id),
      }),
    })),
  );
  const available = found.filter(({ credential }) => credential.token);
  if (available.length > 0) {
    // a provider with no credential is skipped with a note, not a failure
    return listWorkstations([
      ...(await providerAvailability(available)),
      ...found
        .filter(({ credential }) => !credential.token)
        .map(({ id }) => skippedProvider(id)),
    ]);
  }
  const provider = DEFAULT_SELECTION.provider;
  const credential = await enterCommandCredential(
    request,
    provider,
    interaction,
  );
  const problems = await providerPreflight(provider, credential);
  if (!credential.token || problems.length > 0) {
    return prerequisiteFailure(request, problems);
  }

  return retainAcceptedCredential(
    await listWorkstations([
      {
        id: provider,
        driver: bindProvider(provider, credential.token),
      },
    ]),
    { request, provider, credential, interaction },
  );
}

/**
 * resolves the selected provider's credential, asking only in interactive mode
 * @param request parsed command and credential source
 * @param provider selected provider whose declared credential is read
 * @param interaction optional secret prompt
 * @returns the credential and its source, if available
 */
async function resolveCommandCredential(
  request: CommandRequest,
  provider: ProviderId,
  interaction?: Interaction,
): Promise<CommandCredential> {
  const resolved = await resolveProviderCredential(request.options, provider, {
    reference: request.options.providerTokenSource,
  });

  return resolved.token
    ? resolved
    : enterCommandCredential(request, provider, interaction);
}

/**
 * asks for a provider credential in interactive mode, asking again while the
 * entered value is a credential shape the provider refuses
 * @param request parsed command and interactive policy
 * @param provider provider whose declared credential is entered
 * @param interaction optional secret prompt
 * @returns the entered credential, or none in non-interactive mode
 */
async function enterCommandCredential(
  request: CommandRequest,
  provider: ProviderId,
  interaction?: Interaction,
): Promise<CommandCredential> {
  if (!interaction || request.options.nonInteractive) {
    return {};
  }
  const { credential } = catalog.providers[provider].prerequisites;
  const token = await interaction.secret({
    message: credential.label,
    description: `It needs ${credential.scope}. ${credential.obtain}`,
    required: true,
    validate: (value) => enteredCredentialProblem(provider, value),
  });
  rememberSecret(token);

  return { token, source: 'the entered token', isEntered: true };
}

/**
 * routes a command after authenticating the provider driver
 * @param request parsed command and flags
 * @param provider authenticated provider driver
 * @param interaction optional inline interaction boundary
 * @returns the selected workflow's result
 */
async function dispatchAuthenticated(
  request: CommandRequest,
  provider: ProviderDriver,
  interaction?: Interaction,
): Promise<CommandResult> {
  switch (request.command) {
    case 'show':
      return interaction &&
        !request.options.withPairCode &&
        !request.options.inspect
        ? chooseWorkstationAction(request, provider, interaction)
        : showWorkstation(request, provider, interaction);
    case 'doctor':
      return doctorWorkstation(provider, request.machine, interaction);
    case 'setup':
      return setupWorkstation(request, provider, interaction);
    case 'terminate':
      return terminateWorkstation(request, provider, interaction);
    default:
      throw new Error(`Unsupported command: ${request.command}`);
  }
}
