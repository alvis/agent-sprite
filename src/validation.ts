import { harnessIds } from '#core/harnesses';

import { CommandFault, ensureError } from './errors.js';
import { validateMachineName } from './machine.js';
import { promptUnavailableDetail } from './operation.js';
import {
  hasActions,
  hasExplicitPluginActions,
  normalizePluginOptions,
  resolvePluginActions,
} from './plugins.js';

import type { CommandOptions, CommandRequest } from '#command/contracts';

import type { NormalizedPluginOptions, HarnessPluginActions } from '#plugins';

import type { CommandFaultParams } from './errors.js';

/** input failure that can be reported before provider access */
export class CommandValidationError extends CommandFault {
  /**
   * identifies invalid command syntax or conflicting flags
   * @param params actionable usage explanation and original failure
   */
  constructor(params: Omit<CommandFaultParams, 'code'>) {
    super({ ...params, code: 'USAGE' });
  }
}

/**
 * checks deterministic flag conflicts before token lookup or remote I/O
 * @param request parsed command and options to check
 * @param interactionAvailable whether this invocation can ask for consent
 */
export function validateCommandRequest(
  request: CommandRequest,
  interactionAvailable = true,
): void {
  const options = request.options;
  if (request.machine !== undefined) {
    validateMachineName(request.machine);
  }
  if (request.command === 'create' && options.name !== undefined) {
    validateMachineName(options.name);
  }
  if (
    request.command === 'terminate' &&
    (options.nonInteractive || !interactionAvailable) &&
    (!request.machine || !options.yes)
  ) {
    throw new CommandValidationError({
      message: [
        'Non-interactive termination requires an exact workstation name and --yes',
        promptUnavailableDetail(),
      ]
        .filter(Boolean)
        .join('. '),
    });
  }
  validateCommonOptions(options);
  let plugins: HarnessPluginActions;
  const normalizedPlugins = normalizePluginOptions(options);
  try {
    plugins = resolvePluginActions(normalizedPlugins);
  } catch (error) {
    throw new CommandValidationError({
      message: ensureError(error).message,
      cause: error,
    });
  }
  if (request.command === 'setup') {
    validateSetupOptions(options, plugins, normalizedPlugins);
  } else {
    validateNonSetupOptions(options, plugins);
  }
}

/**
 * rejects mutually exclusive options shared across commands
 * @param options parsed flags common to every command
 */
function validateCommonOptions(options: CommandOptions): void {
  if (
    options.gitIdentity === false &&
    (options.gitName ||
      options.gitEmail ||
      options.gitCommitterName ||
      options.gitCommitterEmail)
  ) {
    throw new CommandValidationError({
      message: '--no-git-identity conflicts with explicit Git identity',
    });
  }
  if (options.github === false && options.githubTokenSource) {
    throw new CommandValidationError({
      message: '--no-github conflicts with a GitHub token source',
    });
  }
  if (
    options.localCredentials === false &&
    [
      options.providerTokenSource,
      options.networkKeySource,
      options.networkAuthKeySource,
      options.githubTokenSource,
      options.proxyApiKeySource,
    ].some((source) => source?.startsWith('keychain:'))
  ) {
    throw new CommandValidationError({
      message: '--no-local-credentials conflicts with a keychain source',
    });
  }
}

/**
 * keeps setup mutations on the setup command
 * @param options parsed flags for a command other than setup
 * @param plugins resolved native plugin actions
 */
function validateNonSetupOptions(
  options: CommandOptions,
  plugins: HarnessPluginActions,
): void {
  if (
    options.section ||
    options.pluginHarness ||
    harnessIds().some(
      (id) =>
        plugins[id].removeMarketplaces.length ||
        plugins[id].disablePlugins.length ||
        plugins[id].uninstallPlugins.length,
    )
  ) {
    throw new CommandValidationError({
      message: 'Setup-only options require the setup command',
    });
  }
}

/**
 * requires a usable setup section and consistent harness selection
 * @param options parsed setup flags
 * @param plugins resolved native plugin actions
 * @param normalized normalized plugin input shared with resolution
 */
function validateSetupOptions(
  options: CommandOptions,
  plugins: HarnessPluginActions,
  normalized: NormalizedPluginOptions,
): void {
  const explicit = hasExplicitPluginActions(normalized);
  if (options.withPairCode && explicit) {
    throw new CommandValidationError({
      message: '--with-pair-code conflicts with explicit plugin actions',
    });
  }
  if (
    options.withPairCode &&
    options.section !== undefined &&
    options.section !== 'agent' &&
    options.section !== 'all'
  ) {
    throw new CommandValidationError({
      message: '--with-pair-code requires --section agent or --section all',
    });
  }
  if (explicit && options.section && options.section !== 'plugins') {
    throw new CommandValidationError({
      message:
        'Explicit plugin actions conflict with the selected setup section',
    });
  }
  validateSetupIntegrationOptions(
    options,
    explicit ? 'plugins' : options.section,
  );
  if (
    !options.section &&
    !explicit &&
    !options.withPairCode &&
    options.nonInteractive
  ) {
    throw new CommandValidationError({
      message: [
        'Non-interactive setup requires --section or explicit plugin actions',
        promptUnavailableDetail(),
      ]
        .filter(Boolean)
        .join('. '),
    });
  }
  if (
    options.pluginHarness &&
    harnessIds().some(
      (id) => id !== options.pluginHarness && hasActions(plugins[id]),
    )
  ) {
    throw new CommandValidationError({
      message:
        'Plugin actions for another harness conflict with --plugin-harness',
    });
  }
}

/**
 * keeps explicit integration choices within sections that apply their side effects
 * @param options parsed setup flags
 * @param section explicit or inferred setup section
 */
export function validateSetupIntegrationOptions(
  options: CommandOptions,
  section: CommandOptions['section'],
): void {
  if (!section || section === 'all') {
    return;
  }
  if (section !== 'tools' && options.updateDueDays !== undefined) {
    throw new CommandValidationError({
      message:
        'The update interval switch requires --section tools or --section all',
    });
  }
  if (
    section !== 'network' &&
    (options.network !== undefined || options.useExitNode !== undefined)
  ) {
    throw new CommandValidationError({
      message: 'Network switches require --section network or --section all',
    });
  }
  if (
    options.harness !== undefined ||
    options.idleMinutes !== undefined ||
    options.holdMaxMinutes !== undefined
  ) {
    throw new CommandValidationError({
      message: 'Harness and idle switches require --section all',
    });
  }
  if (section !== 'agent' && options.release !== undefined) {
    throw new CommandValidationError({
      message: 'Release switches require --section agent or --section all',
    });
  }
  if (section !== 'proxy' && options.proxy !== undefined) {
    throw new CommandValidationError({
      message: 'Proxy switches require --section proxy or --section all',
    });
  }
}
