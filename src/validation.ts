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

import type { NormalizedPluginOptions } from '#integrations/native/plugin-actions';

import type { CommandFaultParams } from './errors.js';
import type { HarnessPluginActions } from './plugins.js';

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
  if (options.tailscale === false && options.useExitNode === true) {
    throw new CommandValidationError({
      message:
        '--use-exit-node requires Tailscale; it conflicts with --no-tailscale',
    });
  }
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
      options.spritesTokenSource,
      options.tailscaleApiKeySource,
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
    options.harness ||
    plugins.claude.removeMarketplaces.length ||
    plugins.codex.removeMarketplaces.length ||
    plugins.claude.disablePlugins.length ||
    plugins.codex.disablePlugins.length ||
    plugins.claude.uninstallPlugins.length ||
    plugins.codex.uninstallPlugins.length
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
  if (options.withT3PairCode && explicit) {
    throw new CommandValidationError({
      message: '--with-t3-pair-code conflicts with explicit plugin actions',
    });
  }
  if (
    options.withT3PairCode &&
    options.section !== undefined &&
    options.section !== 't3' &&
    options.section !== 'all'
  ) {
    throw new CommandValidationError({
      message: '--with-t3-pair-code requires --section t3 or --section all',
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
    !options.withT3PairCode &&
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
    options.harness &&
    hasActions(plugins[options.harness === 'claude' ? 'codex' : 'claude'])
  ) {
    throw new CommandValidationError({
      message: 'Plugin actions for another harness conflict with --harness',
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
  if (
    section !== 'tailscale' &&
    (options.tailscale !== undefined || options.useExitNode !== undefined)
  ) {
    throw new CommandValidationError({
      message:
        'Tailscale switches require --section tailscale or --section all',
    });
  }
  if (section !== 'proxy' && options.proxy !== undefined) {
    throw new CommandValidationError({
      message: 'Proxy switches require --section proxy or --section all',
    });
  }
}
