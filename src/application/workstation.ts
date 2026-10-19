import { providerPreflight } from '#application/catalog/preflight';
import { bindProvider } from '#application/catalog/providers';
import { createWorkstation } from '#application/create';
import { commandError } from '#application/failures';
import { resolveProviderCredential } from '#application/input/provider-credential';
import {
  doctorWorkstation,
  listWorkstations,
  showWorkstation,
} from '#application/inspect';
import { setupWorkstation } from '#application/setup';
import { terminateWorkstation } from '#application/terminate';
import { validateCommandRequest } from '#application/validation';
import { PROVIDER_IDS } from '#domain/ids';
import { prerequisiteDetails } from '#domain/prerequisites';
import {
  currentOperation,
  cancellationReason,
  checkOperation,
  withOperation,
  promptUnavailableDetail,
} from '#kernel/operation';

import { chooseWorkstationAction } from './workstation/actions';
import {
  enterCommandCredential,
  resolveCommandCredential,
  retainAcceptedCredential,
} from './workstation/credentials';
import {
  locateProvider,
  providerAvailability,
  skippedProvider,
} from './workstation/providers';

import type {
  CommandRequest,
  WorkstationCommandParams,
} from '#application/contracts';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { Interaction } from '#application/ports/interaction';
import type { CommandResult } from '#application/result';
import type { ProviderId } from '#domain/ids';
import type { PrerequisiteProblem } from '#domain/prerequisites';
import type { OperationContext } from '#kernel/operation';

/** the interaction and caller-owned cancellation scope one command runs with */
export interface CommandSession {
  /** optional prompts, status and progress boundary */
  interaction?: Interaction;
  /** optional explicit caller-owned cancellation scope */
  operation?: OperationContext;
}

/**
 * dispatches one workstation request without starting the CLI or printing its result
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param request command, options and optional machine selection
 * @param session the call's inputs: interaction, operation
 * @returns the structured command result with resolved errors redacted
 * @example
 * const result = await runCommand(createDependencies(), {
 *   command: 'list',
 *   options: { envFile: '.env', nonInteractive: true },
 * });
 */
export async function runCommand(
  dependencies: ApplicationDependencies,
  request: CommandRequest,
  session?: CommandSession,
): Promise<CommandResult> {
  const { interaction, operation } = session ?? {};
  try {
    if (operation) {
      return await withOperation(operation, async () =>
        runCommand(dependencies, request, { interaction }),
      );
    }
    checkOperation();
    currentOperation()?.select(request.command);
    validateCommandRequest(request, Boolean(interaction));
    if (request.command === 'create') {
      return await createWorkstation(dependencies, request, interaction);
    }
    if (request.command === 'list') {
      return await listAvailableProviders(dependencies, request, interaction);
    }
    const provider =
      request.options.provider ??
      (await locateProvider(dependencies, request, interaction)) ??
      dependencies.defaults.selection.provider;
    const credential = await resolveCommandCredential(dependencies, {
      request,
      provider,
      interaction,
    });
    const problems = await providerPreflight(
      { registry: dependencies.registry, host: dependencies.host },
      provider,
      credential,
    );
    if (!credential.token || problems.length > 0) {
      return prerequisiteFailure(request, problems);
    }
    const result = await dispatchAuthenticated(dependencies, {
      request,
      provider: bindProvider(dependencies.registry, provider, credential.token),
      interaction,
    });

    return await retainAcceptedCredential(dependencies, result, {
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
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param request parsed list command
 * @param interaction optional secret prompt when no provider has a credential
 * @returns merged workstations and unavailable providers
 */
async function listAvailableProviders(
  dependencies: ApplicationDependencies,
  request: CommandRequest,
  interaction?: Interaction,
): Promise<CommandResult> {
  const { options } = request;
  // an explicit source names the credential of the selected provider only
  const references = new Map<ProviderId, string>(
    options.providerTokenSource
      ? [
          [
            options.provider ?? dependencies.defaults.selection.provider,
            options.providerTokenSource,
          ],
        ]
      : [],
  );
  const found = await Promise.all(
    PROVIDER_IDS.map(async (id) => ({
      id,
      credential: await resolveProviderCredential(dependencies, {
        options,
        provider: id,
        selection: { reference: references.get(id) },
      }),
    })),
  );
  const available = found.filter(({ credential }) => credential.token);
  if (available.length > 0) {
    // a provider with no credential is skipped with a note, not a failure
    return listWorkstations(dependencies, [
      ...(await providerAvailability(dependencies, available)),
      ...found
        .filter(({ credential }) => !credential.token)
        .map(({ id }) => skippedProvider(dependencies, id)),
    ]);
  }
  const provider = dependencies.defaults.selection.provider;
  const credential = await enterCommandCredential(dependencies, {
    request,
    provider,
    interaction,
  });
  const problems = await providerPreflight(
    { registry: dependencies.registry, host: dependencies.host },
    provider,
    credential,
  );
  if (!credential.token || problems.length > 0) {
    return prerequisiteFailure(request, problems);
  }

  return retainAcceptedCredential(
    dependencies,
    await listWorkstations(dependencies, [
      {
        id: provider,
        driver: bindProvider(dependencies.registry, provider, credential.token),
      },
    ]),
    { request, provider, credential, interaction },
  );
}

/**
 * routes a command after authenticating the provider driver
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param params the call's inputs: request, provider, interaction
 * @returns the selected workflow's result
 */
async function dispatchAuthenticated(
  dependencies: ApplicationDependencies,
  params: WorkstationCommandParams,
): Promise<CommandResult> {
  const { request, provider, interaction } = params;
  switch (request.command) {
    case 'show':
      return interaction &&
        !request.options.withPairCode &&
        !request.options.inspect
        ? chooseWorkstationAction(dependencies, {
            request,
            provider,
            interaction,
          })
        : showWorkstation(dependencies, { request, provider, interaction });
    case 'doctor':
      return doctorWorkstation(dependencies, {
        provider,
        requestedName: request.machine,
        interaction,
      });
    case 'setup':
      return setupWorkstation(dependencies, { request, provider, interaction });
    case 'terminate':
      return terminateWorkstation(dependencies, {
        request,
        provider,
        interaction,
      });
    default:
      throw new Error(`Unsupported command: ${request.command}`);
  }
}
