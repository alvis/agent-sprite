import { buildCommand } from '@stricli/core';

import {
  createDocumentation,
  doctorDocumentation,
  listDocumentation,
  setupDocumentation,
  showDocumentation,
  terminateDocumentation,
} from './documentation';
import { execute } from './execute';
import {
  commonFlags,
  consentFlags,
  integrationCredentialFlags,
  integrationFlags,
  networkCredentialFlags,
  networkSelectionFlags,
  outputFlags,
  pairingFlags,
  pluginFlags,
  providerCredentialFlags,
  providerFlags,
  selectionFlags,
  setupFlags,
} from './flags';
import { guestFileFlags } from './guest-file-flags';
import {
  harnessPluginChangeFlags,
  harnessPluginFlags,
  harnessPluginOptions,
} from './harness-flags';

import type { Command } from '@stricli/core';

import type { CommandOptions } from '#application/contracts';

import type {
  HarnessPluginFlagValues,
  HarnessPluginSelectionValues,
} from './harness-flags';
import type { InvocationContext } from './parser';

type BooleanKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends boolean ? K : never;
}[keyof T];
type OptionalBooleanKey =
  | 'withPairCode'
  | 'proxy'
  | 'useExitNode'
  | 'github'
  | 'gitIdentity'
  | 'plugins'
  | 'localCredentials'
  | 'color';
type RequiredBooleanFields<T> = Omit<T, BooleanKeys<T>> &
  Required<Pick<T, Exclude<BooleanKeys<T>, OptionalBooleanKey>>> &
  Pick<T, Extract<BooleanKeys<T>, OptionalBooleanKey>>;
type FlagsFor<T> = RequiredBooleanFields<
  Pick<CommandOptions, Extract<keyof T, keyof CommandOptions>>
>;
type CommonFlags = FlagsFor<typeof commonFlags>;
type ProviderCommonFlags = CommonFlags & FlagsFor<typeof providerFlags>;
type ConfigurationFlags = FlagsFor<
  typeof consentFlags &
    typeof pairingFlags &
    typeof selectionFlags &
    typeof integrationFlags &
    typeof guestFileFlags &
    typeof providerCredentialFlags &
    typeof networkCredentialFlags &
    typeof integrationCredentialFlags &
    typeof pluginFlags &
    typeof outputFlags
> &
  HarnessPluginSelectionValues;
type CreateFlags = ConfigurationFlags & Pick<CommandOptions, 'name'>;
type SetupFlags = ConfigurationFlags &
  FlagsFor<typeof setupFlags> &
  HarnessPluginFlagValues;
type InspectFlags = ProviderCommonFlags &
  Required<Pick<CommandOptions, 'inspect'>> &
  Pick<CommandOptions, 'withPairCode'>;
type TerminateFlags = FlagsFor<
  typeof consentFlags &
    typeof networkSelectionFlags &
    typeof providerFlags &
    typeof providerCredentialFlags &
    typeof networkCredentialFlags &
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
    return execute({
      dependencies: this.dependencies,
      request: {
        command: 'create',
        options: { ...flags, harnessPlugins: harnessPluginOptions(flags) },
      },
      state: this.state,
    });
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
      ...selectionFlags,
      ...integrationFlags,
      ...guestFileFlags,
      ...providerCredentialFlags,
      ...networkCredentialFlags,
      ...integrationCredentialFlags,
      ...pluginFlags,
      ...harnessPluginFlags,
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
    return execute({
      dependencies: this.dependencies,
      request: {
        command: 'setup',
        machine,
        options: { ...flags, harnessPlugins: harnessPluginOptions(flags) },
      },
      state: this.state,
    });
  },
  parameters: {
    flags: {
      ...setupFlags,
      ...consentFlags,
      ...pairingFlags,
      ...selectionFlags,
      ...integrationFlags,
      ...guestFileFlags,
      ...providerCredentialFlags,
      ...networkCredentialFlags,
      ...integrationCredentialFlags,
      ...pluginFlags,
      ...harnessPluginFlags,
      ...harnessPluginChangeFlags,
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
  async func(
    this: InvocationContext,
    flags: ProviderCommonFlags,
  ): Promise<void> {
    return execute({
      dependencies: this.dependencies,
      request: { command: 'list', options: flags },
      state: this.state,
    });
  },
  parameters: { flags: { ...providerFlags, ...commonFlags } },
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
    return execute({
      dependencies: this.dependencies,
      request: { command: 'show', machine, options: flags },
      state: this.state,
    });
  },
  parameters: {
    flags: {
      inspect: {
        kind: 'boolean',
        default: false,
        brief: 'check live guest services and configuration (may wake it)',
      },
      ...pairingFlags,
      ...providerFlags,
      ...providerCredentialFlags,
      localCredentials: {
        ...providerCredentialFlags.localCredentials,
        brief: 'use or skip the provider credential saved on this computer',
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
    return execute({
      dependencies: this.dependencies,
      request: { command: 'terminate', machine, options: flags },
      state: this.state,
    });
  },
  parameters: {
    flags: {
      ...consentFlags,
      ...networkSelectionFlags,
      ...providerFlags,
      ...providerCredentialFlags,
      ...networkCredentialFlags,
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
    flags: ProviderCommonFlags,
    machine?: string,
  ): Promise<void> {
    return execute({
      dependencies: this.dependencies,
      request: { command: 'doctor', machine, options: flags },
      state: this.state,
    });
  },
  parameters: {
    flags: { ...providerFlags, ...commonFlags },
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
