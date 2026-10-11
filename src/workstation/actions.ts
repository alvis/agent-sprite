import { commandError, CommandFault } from '#errors';
import { selectManagedMachine, showWorkstation } from '#inspect';
import { copyUrl } from '#integrations/clipboard';
import { summarizeMachine } from '#machine';
import { InteractionExit, returnOnBack, withBackNavigation } from '#navigation';
import { currentOperation, checkOperation } from '#operation';
import { setupWorkstation } from '#setup';
import { terminateWorkstation } from '#terminate';

import type { SpritesClient } from '@fly/sprites';

import type { CommandResult } from '#command';
import type {
  CommandName,
  CommandRequest,
  Interaction,
  InteractionChoice,
} from '#command/contracts';
import type { MachineSummary } from '#machine';

interface WorkstationActionContext {
  request: CommandRequest;
  machine: MachineSummary;
  client: SpritesClient;
  interaction: Interaction;
}

type WorkstationAction =
  'details' | 'pair' | 'inspect' | 'setup' | 'copy' | 'terminate';

const WORKSTATION_ACTIONS: Array<InteractionChoice<WorkstationAction>> = [
  { label: 'Show details', value: 'details' },
  {
    label: 'Pair another T3 client',
    value: 'pair',
    description: 'Add a new pairing code to the T3 URL, valid for 5 minutes',
  },
  {
    label: 'Inspect workstation',
    value: 'inspect',
    description:
      'Check live services, routing and native harnesses; may wake the Sprite',
  },
  {
    label: 'Configure a section',
    value: 'setup',
    description:
      'Choose plugins, Tailscale, proxy, Git, tools or another setup area',
  },
  { label: 'Copy T3 URL', value: 'copy' },
  { label: 'Permanently terminate', value: 'terminate' },
];

/**
 * presents explicit actions after showing a control-plane machine summary
 * @param request parsed show command
 * @param client authenticated Sprite client
 * @param interaction interactive UI boundary
 * @returns the selected action's structured result
 */
export async function chooseWorkstationAction(
  request: CommandRequest,
  client: SpritesClient,
  interaction: Interaction,
): Promise<CommandResult> {
  let requestedMachine = request.machine;
  for (;;) {
    const sprite = await selectManagedMachine(
      client,
      requestedMachine,
      interaction,
    );
    const machine = summarizeMachine(sprite);
    checkOperation();
    interaction.status({
      kind: 'info',
      message: `${machine.name} (${machine.id}) · ${machine.state}`,
    });
    const result = await chooseMachineAction({
      request,
      machine,
      client,
      interaction,
    });
    if (result) {
      return result;
    }
    requestedMachine = undefined;
  }
}

/**
 * keeps pre-mutation action navigation within the selected workstation
 * @param context original request, machine summary, client and active prompts
 * @returns final action result or back to the machine list
 */
async function chooseMachineAction(
  context: WorkstationActionContext,
): Promise<CommandResult | undefined> {
  const { request, machine, interaction } = context;
  const menu = withBackNavigation(interaction, 'back to workstation list');
  for (;;) {
    const action = await returnOnBack(async () =>
      menu.select({ message: 'Workstation action' }, WORKSTATION_ACTIONS),
    );
    if (!action) {
      return undefined;
    }
    const result = await returnOnBack(async () =>
      applyWorkstationAction(action, {
        ...context,
        request: { ...request, machine: machine.name },
      }),
    );
    if (result) {
      return result;
    }
  }
}

/**
 * dispatches an explicitly selected action with a safe parent destination
 * @param action selected task identity
 * @param context exact request, live summary, provider client and prompts
 * @returns the selected task result
 */
async function applyWorkstationAction(
  action: WorkstationAction,
  context: WorkstationActionContext,
): Promise<CommandResult> {
  const { request, machine, client, interaction } = context;
  const nested = withBackNavigation(interaction, 'back to actions');
  const actionRequest = menuActionRequest(request);
  currentOperation()?.select(
    action === 'setup'
      ? 'setup'
      : action === 'terminate'
        ? 'terminate'
        : 'show',
  );
  try {
    if (action === 'setup') {
      return await setupWorkstation(
        { ...actionRequest, command: 'setup' },
        client,
        nested,
      );
    }
    if (action === 'terminate') {
      return await terminateWorkstation(
        { ...actionRequest, command: 'terminate' },
        client,
        nested,
      );
    }
    if (action === 'copy') {
      return await copyWorkstationUrl(machine);
    }

    return await showWorkstation(
      {
        ...actionRequest,
        options: {
          ...actionRequest.options,
          withT3PairCode: action === 'pair',
          inspect: action === 'inspect',
        },
      },
      client,
      nested,
    );
  } catch (error) {
    if (error instanceof InteractionExit && error.action === 'back') {
      throw error;
    }

    return {
      command: actionCommand(action),
      ok: false,
      error: {
        ...commandError(error),
        machine: machine.name,
        machineId: machine.id,
      },
    };
  }
}

/**
 * sends the provider T3 URL to the desktop clipboard
 * @param machine current machine summary containing a provider URL
 * @returns the completed local action and machine summary
 */
async function copyWorkstationUrl(
  machine: MachineSummary,
): Promise<CommandResult> {
  if (!machine.t3Url) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: 'Sprite has no provider T3 URL',
    });
  }
  await copyUrl(
    typeof machine.t3Url === 'string'
      ? machine.t3Url
      : machine.t3Url.disclose(false)!,
  );

  return { command: 'show', ok: true, data: { machine, action: 'copy' } };
}

/**
 * clears outer consent before executing an independently selected menu action
 * @param request outer show invocation and exact selected machine
 * @returns action request requiring its own consent
 */
function menuActionRequest(request: CommandRequest): CommandRequest {
  return {
    ...request,
    options: {
      ...request.options,
      yes: false,
      withT3PairCode: false,
      inspect: false,
    },
  };
}

/**
 * identifies the command selected by a workstation action
 * @param action selected menu action
 * @returns actual command identity
 */
function actionCommand(action: WorkstationAction): CommandName {
  return action === 'setup'
    ? 'setup'
    : action === 'terminate'
      ? 'terminate'
      : 'show';
}
