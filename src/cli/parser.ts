import process, { stdout } from 'node:process';

import {
  ArgumentScannerError,
  formatMessageForArgumentScannerError,
  run,
  text_en,
} from '@stricli/core';

import { commandError } from '#application/failures';
import { registry } from '#composition/registry';
import { pairingAgentIds } from '#domain/ids';
import { ensureError } from '#kernel/faults';
import { redactResolved } from '#kernel/redaction';

import { harnessPluginToggleNames } from './flags/harness';

import type {
  Application,
  ApplicationText,
  CommandContext,
  FlagNotFoundError,
  StricliProcess,
} from '@stricli/core';

import type { CommandError } from '#application/failures';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { CommandName } from '#kernel/commands';

/** invocation-local parser and final-output ownership */
export interface ExecutionState {
  emitted: boolean;
  command: CommandName | null;
  errors: CommandError[];
}

/** supported command context carries the current invocation explicitly */
export interface InvocationContext extends CommandContext {
  state: ExecutionState;
  dependencies: ApplicationDependencies;
}

/** parser application, input arguments and invocation context */
export interface ParseApplicationParams {
  application: Application<InvocationContext>;
  argv: string[];
  context: Pick<InvocationContext, 'state' | 'dependencies'>;
}

/**
 * executes parser hooks through supported streams without leaking default stacks
 * @param params typed application, original arguments and invocation context
 * @param params.application configured parser application
 * @param params.argv command arguments
 * @param params.context the call's inputs: state, dependencies
 */
export async function parseApplication({
  application,
  argv,
  context,
}: ParseApplicationParams): Promise<void> {
  const { state, dependencies } = context;
  const flagError = validateBooleanFlagSyntax(argv);
  if (flagError) {
    state.errors.push(flagError);

    return;
  }
  const contextProcess: StricliProcess = {
    stdout: argv.some((argument) =>
      ['--help', '-h', '--version', '-v'].includes(argument),
    )
      ? stdout
      : {
          write: (text) => {
            if (argv.length === 0) {
              stdout.write(text);
            }
          },
        },
    stderr: { write: () => undefined },
    env: process.env,
    /** @returns the current process exit status */
    get exitCode() {
      return process.exitCode;
    },
    /** @param value parser-owned status before D10 normalization */
    set exitCode(value) {
      process.exitCode = value;
    },
  };
  try {
    await run(application, withPairingAliases(argv, application), {
      process: contextProcess,
      state,
      dependencies,
    });
  } catch (error) {
    state.errors.push(commandError(error));
  }
}

const PAIRED_BOOLEAN_FLAGS = [
  'color',
  'local-credentials',
  'github',
  'git-identity',
  'plugins',
  ...harnessPluginToggleNames(),
  'proxy',
  'use-exit-node',
];

/**
 * names the per-agent spellings of --with-pair-code
 * @returns alias flags, one per pairing-capable ACP agent
 */
function pairingAliases(): string[] {
  return pairingAgentIds(registry).map((id) => `--with-${id}-pair-code`);
}

/**
 * rewrites the per-agent pairing aliases to --with-pair-code before parsing
 * @param argv original command-line arguments
 * @param application command routes whose value-taking flags consume the next argument
 * @returns arguments with aliases replaced up to any `--` separator, leaving flag values intact
 */
function withPairingAliases(
  argv: string[],
  application: Application<InvocationContext>,
): string[] {
  const aliases = new Set(pairingAliases());
  const valueFlags = valueFlagsOf(application, argv[0]);
  const end = argv.includes('--') ? argv.indexOf('--') : argv.length;
  let isFlagValue = false;

  return argv.map((argument, index) => {
    const isValue = isFlagValue;
    isFlagValue = index < end && !isValue && valueFlags.has(argument);

    return index < end && !isValue && aliases.has(argument)
      ? '--with-pair-code'
      : argument;
  });
}

/**
 * lists the spellings of a command's flags that take the following argument as their value
 * @param application command routes
 * @param command requested top-level command input
 * @returns camel and kebab spellings of every parsed or enum flag
 */
function valueFlagsOf(
  application: Application<InvocationContext>,
  command: string | undefined,
): Set<string> {
  const { root } = application;
  const target =
    command !== undefined && 'getRoutingTargetForInput' in root
      ? root.getRoutingTargetForInput(command)
      : root;
  const flags =
    target && 'parameters' in target ? (target.parameters.flags ?? {}) : {};

  return new Set(
    Object.entries(flags)
      .filter(([, flag]) => flag.kind === 'parsed' || flag.kind === 'enum')
      .flatMap(([name]) => [`--${name}`, kebabFlag(name)]),
  );
}

/**
 * spells a camel-case flag name the way users type it
 * @param name internal camel-case flag name
 * @returns kebab-case flag with its leading dashes
 */
function kebabFlag(name: string): string {
  return `--${name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

/**
 * rejects removed and contradictory boolean syntax before provider authentication
 * @param argv original command arguments
 * @returns actionable parser failure, when supplied flags cannot be combined
 */
function validateBooleanFlagSyntax(argv: string[]): CommandError | undefined {
  const flags = new Set(
    argv.includes('--') ? argv.slice(1, argv.indexOf('--')) : argv.slice(1),
  );
  for (const removed of [
    '--no-pair',
    '--include-pairing',
    '--no-include-pairing',
  ]) {
    if (flags.has(removed)) {
      return {
        code: 'USAGE',
        message: `${removed} was removed; use --with-pair-code to request a pairing code.`,
      };
    }
  }
  const negatedPairing = ['--with-pair-code', ...pairingAliases()].find(
    (flag) => flags.has(`--no-${flag.slice(2)}`),
  );
  if (negatedPairing) {
    return {
      code: 'USAGE',
      message: `--no-${negatedPairing.slice(2)} is not supported; omit ${negatedPairing} to skip pairing.`,
    };
  }
  const doubleNegation = [...flags].find((flag) => flag.startsWith('--no-no-'));
  if (doubleNegation) {
    const name = doubleNegation.slice('--no-no-'.length);

    return {
      code: 'USAGE',
      message: `${doubleNegation} is invalid; use --${name} or --no-${name}.`,
    };
  }
  for (const flag of PAIRED_BOOLEAN_FLAGS) {
    if (flags.has(`--${flag}`) && flags.has(`--no-${flag}`)) {
      return {
        code: 'USAGE',
        message: `--${flag} and --no-${flag} are mutually exclusive; choose one.`,
      };
    }
  }

  return undefined;
}

/**
 * resolves command identity without guessing from an invalid parser input
 * @param argv original arguments
 * @returns recognized top-level command or null
 */
export function requestedCommand(argv: string[]): CommandName | null {
  switch (argv[0]) {
    case 'create':
    case 'setup':
    case 'list':
    case 'show':
    case 'terminate':
    case 'doctor':
      return argv[0];
    default:
      return null;
  }
}

/**
 * captures supported Stricli diagnostics without printing its default stacks
 * @param state invocation-local parser observations
 * @returns complete text callbacks using the installed parser formatter
 */
export function applicationText(state: ExecutionState): ApplicationText {
  const record = (error: CommandError): string => {
    state.errors.push(error);

    return '';
  };
  const failure = (error: unknown): string => record(commandError(error));

  return {
    ...text_en,
    formatException: (error) => redactResolved(ensureError(error).message),
    exceptionWhileParsingArguments: (error) =>
      record(
        error instanceof ArgumentScannerError
          ? {
              code: 'USAGE',
              message: redactResolved(
                formatMessageForArgumentScannerError(error, {
                  FlagNotFoundError: formatFlagSuggestion,
                }),
              ),
            }
          : commandError(error),
      ),
    noCommandRegisteredForInput: (args) =>
      record({
        code: 'USAGE',
        message: redactResolved(
          text_en.noCommandRegisteredForInput({ ...args, ansiColor: false }),
        ),
      }),
    exceptionWhileLoadingCommandFunction: failure,
    exceptionWhileLoadingCommandContext: failure,
    exceptionWhileRunningCommand: failure,
    commandErrorResult: failure,
    exceptionWhileRunningIntegrationHook: ({ exception }) => failure(exception),
    exceptionWhileRunningIntegrationFlag: ({ exception }) => failure(exception),
  };
}

/**
 * formats only Stricli's proposed flag names into the accepted kebab spelling
 * @param error typed unknown-flag diagnostic and candidate names
 * @returns complete original reason or an equally scoped correction message
 */
function formatFlagSuggestion(error: FlagNotFoundError): string {
  if (error.aliasName || error.corrections.length === 0) {
    return error.message;
  }
  const suggestions = error.corrections.map(kebabFlag);
  const formatted = new Intl.ListFormat('en', {
    style: 'long',
    type: 'disjunction',
  }).format(suggestions);

  return `No flag registered for --${error.input}, did you mean ${formatted}?`;
}
