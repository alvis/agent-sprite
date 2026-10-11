import { createWorkstation } from '#create';
import { commandError } from '#errors';
import { resolveSpritesToken, retainManagementCredential } from '#input';
import {
  spritesTokenGuidance,
  spritesTokenPromptDescription,
} from '#input/token-guidance';
import { doctorWorkstation, listWorkstations, showWorkstation } from '#inspect';
import { createSpritesClient } from '#integrations/sprites';
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

import type { SpritesClient } from '@fly/sprites';

import type { CommandResult } from '#command';
import type { CommandRequest, Interaction } from '#command/contracts';
import type { CredentialSaveResult } from '#integrations/credentials';
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
 *   options: { env: '.env', nonInteractive: true },
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
    const { token, retainedCredential } = await resolveCommandToken(
      request,
      interaction,
    );
    if (!token) {
      const promptHint = promptUnavailableDetail();

      return {
        command: request.command,
        ok: false,
        error: {
          code: 'INPUT',
          message: 'SPRITES_TOKEN is required.',
          details: [
            ...spritesTokenGuidance,
            ...(promptHint ? [promptHint] : []),
          ],
        },
      };
    }

    const result = await dispatchAuthenticated(
      request,
      createSpritesClient(token),
      interaction,
    );

    return attachRetainedCredential(result, retainedCredential);
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
              `Inspect: agent-sprite show ${JSON.stringify(machine)} --inspect`,
              'Remote work may be unfinished; inspect before retrying mutations.',
            ]
          : failure.details,
    },
  };
}

/**
 * Carries observed local storage into the command's printable result.
 * @param result authenticated command result
 * @param retainedCredential observed local save, if consented
 * @returns result with non-secret storage metadata
 */
function attachRetainedCredential(
  result: CommandResult,
  retainedCredential?: CredentialSaveResult,
): CommandResult {
  return result.ok && retainedCredential
    ? { ...result, retainedCredential }
    : result;
}

/**
 * resolves a local provider credential and asks only in interactive mode
 * @param request parsed command and credential source
 * @param interaction optional secret prompt
 * @returns the provider token, if available
 */
async function resolveCommandToken(
  request: CommandRequest,
  interaction?: Interaction,
): Promise<{ token?: string; retainedCredential?: CredentialSaveResult }> {
  let token = await resolveSpritesToken(request.options);
  let retainedCredential: CredentialSaveResult | undefined;
  if (!token && interaction && !request.options.nonInteractive) {
    token = await interaction.secret({
      message: 'Sprites API token',
      description: spritesTokenPromptDescription,
      required: true,
    });
    rememberSecret(token);
    if (token && request.options.localCredentials !== false) {
      retainedCredential = await retainManagementCredential('sprites', token, {
        interaction,
        options: request.options,
      });
    }
  }

  return { token, retainedCredential };
}

/**
 * routes a command after authenticating the provider client
 * @param request parsed command and flags
 * @param client authenticated Sprite client
 * @param interaction optional inline interaction boundary
 * @returns the selected workflow's result
 */
async function dispatchAuthenticated(
  request: CommandRequest,
  client: SpritesClient,
  interaction?: Interaction,
): Promise<CommandResult> {
  switch (request.command) {
    case 'list':
      return listWorkstations(client);
    case 'show':
      return interaction &&
        !request.options.withT3PairCode &&
        !request.options.inspect
        ? chooseWorkstationAction(request, client, interaction)
        : showWorkstation(request, client, interaction);
    case 'doctor':
      return doctorWorkstation(client, request.machine, interaction);
    case 'setup':
      return setupWorkstation(request, client, interaction);
    case 'terminate':
      return terminateWorkstation(request, client, interaction);
    default:
      throw new Error(`Unsupported command: ${request.command}`);
  }
}
