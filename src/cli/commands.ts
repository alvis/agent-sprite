import { buildCommand } from '@stricli/core';

import { execute } from './execute.js';
import {
  commonFlags,
  consentFlags,
  integrationCredentialFlags,
  integrationFlags,
  outputFlags,
  pairingFlags,
  pluginChangeFlags,
  pluginFlags,
  providerCredentialFlags,
  setupFlags,
  tailnetCredentialFlags,
  tailnetSelectionFlags,
} from './flags.js';

import type { Command } from '@stricli/core';

import type { CommandOptions } from '#command/contracts';

import type { InvocationContext } from './parser.js';

/** complete create guidance without turning optional integrations into defaults */
const createDocumentation = {
  brief: 'create one new coding workstation',
  customUsage: ['[--name NAME] [options]'],
  fullDescription: `Creates a private workstation, verifies readiness, then exposes its T3 URL.
The flag table follows operation and name, integrations, credentials, plugins,
then output and automation. Optional integrations and plugins need a selection;
--with-t3-pair-code alone requests a new five-minute pairing code.

EXAMPLES
  agent-sprite create --name devbox
  agent-sprite create --name devbox --no-github
  agent-sprite create --name devbox --with-t3-pair-code --json --non-interactive`,
} as const;

/** setup sections remain explicit even when pairing selects T3 */
const setupDocumentation = {
  brief: 'configure an existing workstation',
  customUsage: ['[<workstation>] [--section SECTION] [options]'],
  fullDescription: `Changes only the selected setup section. Without a workstation name,
interactive mode offers a selection. --with-t3-pair-code selects the T3 section
when --section is omitted; it also works with --section all. The flag table
groups operation, integrations, credentials, plugins, then output controls.

EXAMPLES
  agent-sprite setup devbox --section t3
  agent-sprite setup devbox --section all --yes
  agent-sprite setup devbox --with-t3-pair-code`,
} as const;

/** list guidance keeps the provider-only read and output modes clear */
const listDocumentation = {
  brief: 'list owned workstations from Fly live',
  customUsage: ['[options]'],
  fullDescription: `Lists current managed workstations from the provider without waking
their guests. Credentials appear first in the flag table, then output and
automation controls. --json emits one structured result.

EXAMPLES
  agent-sprite list
  agent-sprite list --json
  agent-sprite list --no-local-credentials --sprites-token-source env:SPRITES_TOKEN`,
} as const;

/** documents workstation details, explicit inspection and pairing */
export const showDocumentation = {
  brief: 'show a workstation from current control-plane state',
  customUsage: ['[<workstation>] [--inspect] [--with-t3-pair-code] [options]'],
  fullDescription: `Shows current provider details and the ordinary T3 URL without
waking the guest. --inspect checks live guest services and may wake it; use
doctor for a readiness-focused report. --with-t3-pair-code creates one code
valid for five minutes and appends it to the T3 URL. A bare interactive show
opens the workstation action menu. Credentials precede output controls below.

EXAMPLES
  agent-sprite show devbox
  agent-sprite show devbox --inspect
  agent-sprite show devbox --with-t3-pair-code --json`,
};

/** deletion consent is command-specific and exact-name scoped */
const terminateDocumentation = {
  brief: 'permanently delete a managed workstation',
  customUsage: ['[<workstation>] [--yes] [options]'],
  fullDescription: `Deletes a managed workstation after confirmation. In
non-interactive mode, provide an exact workstation name and --yes. Tailnet
cleanup options follow the operation flag; credentials and output controls
follow them. --yes confirms only the already selected deletion.

EXAMPLES
  agent-sprite terminate devbox
  agent-sprite terminate devbox --yes --non-interactive`,
} as const;

/** readiness checks are separate from control-plane details */
const doctorDocumentation = {
  brief: 'check current workstation readiness',
  customUsage: ['[<workstation>] [options]'],
  fullDescription: `Inspects current guest services, routing, and native setup;
the check may wake the guest. Use show for provider details or show --inspect
for details together with a live inspection. Credentials precede output
controls in the flag table.

EXAMPLES
  agent-sprite doctor devbox
  agent-sprite doctor devbox --json
  agent-sprite doctor devbox --non-interactive`,
} as const;

type BooleanKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends boolean ? K : never;
}[keyof T];
type OptionalBooleanKey =
  | 'withT3PairCode'
  | 'tailscale'
  | 'proxy'
  | 'useExitNode'
  | 'github'
  | 'gitIdentity'
  | 'plugins'
  | 'claudePlugins'
  | 'codexPlugins'
  | 'localCredentials'
  | 'color';
type RequiredBooleanFields<T> = Omit<T, BooleanKeys<T>> &
  Required<Pick<T, Exclude<BooleanKeys<T>, OptionalBooleanKey>>> &
  Pick<T, Extract<BooleanKeys<T>, OptionalBooleanKey>>;
type FlagsFor<T> = RequiredBooleanFields<
  Pick<CommandOptions, Extract<keyof T, keyof CommandOptions>>
>;
type CommonFlags = FlagsFor<typeof commonFlags>;
type ConfigurationFlags = FlagsFor<
  typeof consentFlags &
    typeof pairingFlags &
    typeof integrationFlags &
    typeof providerCredentialFlags &
    typeof tailnetCredentialFlags &
    typeof integrationCredentialFlags &
    typeof pluginFlags &
    typeof outputFlags
>;
type CreateFlags = ConfigurationFlags & Pick<CommandOptions, 'name'>;
type SetupFlags = FlagsFor<
  typeof consentFlags &
    typeof pairingFlags &
    typeof integrationFlags &
    typeof providerCredentialFlags &
    typeof tailnetCredentialFlags &
    typeof integrationCredentialFlags &
    typeof pluginFlags &
    typeof outputFlags &
    typeof pluginChangeFlags &
    typeof setupFlags
>;
type InspectFlags = CommonFlags &
  Required<Pick<CommandOptions, 'inspect'>> &
  Pick<CommandOptions, 'withT3PairCode'>;
type TerminateFlags = FlagsFor<
  typeof consentFlags &
    typeof tailnetSelectionFlags &
    typeof providerCredentialFlags &
    typeof tailnetCredentialFlags &
    typeof outputFlags
>;

const machinePositional = {
  kind: 'tuple',
  parameters: [
    {
      parse: String,
      brief: 'exact workstation name',
      placeholder: 'workstation',
      optional: true,
    },
  ],
} as const;

const createCommand = buildCommand({
  /**
   * executes parsed flags with invocation-local output ownership
   * @param flags parsed command options
   * @returns completion after final output
   */
  async func(this: InvocationContext, flags: CreateFlags): Promise<void> {
    return execute({ command: 'create', options: flags }, this.state);
  },
  parameters: {
    flags: {
      name: {
        kind: 'parsed',
        parse: String,
        optional: true,
        placeholder: 'NAME',
        brief: 'NAME · new workstation name',
      },
      ...consentFlags,
      ...pairingFlags,
      ...integrationFlags,
      ...providerCredentialFlags,
      ...tailnetCredentialFlags,
      ...integrationCredentialFlags,
      ...pluginFlags,
      ...outputFlags,
    },
  },
  docs: createDocumentation,
});
const setupCommand = buildCommand({
  /**
   * executes the selected workstation command
   * @param flags parsed command options
   * @param machine optional exact workstation name
   * @returns completion after final output
   */
  async func(
    this: InvocationContext,
    flags: SetupFlags,
    machine?: string,
  ): Promise<void> {
    return execute({ command: 'setup', machine, options: flags }, this.state);
  },
  parameters: {
    flags: {
      ...setupFlags,
      ...consentFlags,
      ...pairingFlags,
      ...integrationFlags,
      ...providerCredentialFlags,
      ...tailnetCredentialFlags,
      ...integrationCredentialFlags,
      ...pluginFlags,
      ...pluginChangeFlags,
      ...outputFlags,
    },
    positional: machinePositional,
  },
  docs: setupDocumentation,
});
const listCommand = buildCommand({
  /**
   * executes parsed flags with invocation-local output ownership
   * @param flags parsed command options
   * @returns completion after final output
   */
  async func(this: InvocationContext, flags: CommonFlags): Promise<void> {
    return execute({ command: 'list', options: flags }, this.state);
  },
  parameters: { flags: commonFlags },
  docs: listDocumentation,
});
const showCommand = buildCommand({
  /**
   * executes the selected workstation command
   * @param flags parsed command options
   * @param machine optional exact workstation name
   * @returns completion after final output
   */
  async func(
    this: InvocationContext,
    flags: InspectFlags,
    machine?: string,
  ): Promise<void> {
    return execute({ command: 'show', machine, options: flags }, this.state);
  },
  parameters: {
    flags: {
      inspect: {
        kind: 'boolean',
        default: false,
        brief: 'check live guest services and configuration (may wake it)',
      },
      ...pairingFlags,
      ...providerCredentialFlags,
      localCredentials: {
        ...providerCredentialFlags.localCredentials,
        brief: 'use or skip the Sprites token saved on this computer',
      },
      ...outputFlags,
    },
    positional: machinePositional,
  },
  docs: showDocumentation,
});
const terminateCommand = buildCommand({
  /**
   * executes the selected workstation command
   * @param flags parsed command options
   * @param machine optional exact workstation name
   * @returns completion after final output
   */
  async func(
    this: InvocationContext,
    flags: TerminateFlags,
    machine?: string,
  ): Promise<void> {
    return execute(
      { command: 'terminate', machine, options: flags },
      this.state,
    );
  },
  parameters: {
    flags: {
      ...consentFlags,
      ...tailnetSelectionFlags,
      ...providerCredentialFlags,
      ...tailnetCredentialFlags,
      ...outputFlags,
    },
    positional: machinePositional,
  },
  docs: terminateDocumentation,
});
const doctorCommand = buildCommand({
  /**
   * executes the selected workstation command
   * @param flags parsed command options
   * @param machine optional exact workstation name
   * @returns completion after final output
   */
  async func(
    this: InvocationContext,
    flags: CommonFlags,
    machine?: string,
  ): Promise<void> {
    return execute({ command: 'doctor', machine, options: flags }, this.state);
  },
  parameters: {
    flags: commonFlags,
    positional: machinePositional,
  },
  docs: doctorDocumentation,
});

/**
 * keeps root route usage concise while naming optional workstation selection
 * @param command built command and its supported usage formatter
 * @param optional one optional usage fragment for the root route table
 * @returns equivalent command with concise root usage
 */
function withRootUsage(
  command: Command<InvocationContext>,
  optional: string,
): Command<InvocationContext> {
  return {
    ...command,
    formatUsageLine: (args) => `${command.formatUsageLine(args)} ${optional}`,
  };
}

export const commandRoutes = {
  create: withRootUsage(createCommand, '[--name NAME]'),
  setup: withRootUsage(setupCommand, '[<workstation>]'),
  list: listCommand,
  show: withRootUsage(showCommand, '[<workstation>]'),
  terminate: withRootUsage(terminateCommand, '[<workstation>]'),
  doctor: withRootUsage(doctorCommand, '[<workstation>]'),
};
