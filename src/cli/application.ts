import process from 'node:process';

import { buildApplication, buildRouteMap } from '@stricli/core';

import { createDependencies } from '#composition/dependencies';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { commandRoutes } from './commands';
import { emitResult } from './emission';
import { applicationText, parseApplication, requestedCommand } from './parser';

import type { Application, RouteMap } from '@stricli/core';

import type { DriverRegistry } from '#application/ports/drivers';

import type { ExecutionState, InvocationContext } from './parser';

const ENVIRONMENT_NAME_WIDTH = 19;

/**
 * executes the compiled Stricli application
 * @param argv command-line arguments after the executable name
 */
export async function cli(argv: string[]): Promise<void> {
  const state: ExecutionState = {
    emitted: false,
    command: requestedCommand(argv),
    errors: [],
  };
  process.exitCode = undefined;
  const dependencies = createDependencies();
  const jsonRequested = argv.includes('--json');
  const helpRequested = argv.some((argument) =>
    ['--help', '-h', '--version', '-v'].includes(argument),
  );
  if (jsonRequested && helpRequested) {
    emitJsonWithHelpFailure(state);

    return;
  }
  try {
    await parseApplication({
      application: createApplication(state, dependencies.registry),
      argv,
      context: { state, dependencies },
    });
    if (!state.emitted && state.errors.length > 0) {
      const first = state.errors[0]!;
      state.emitted = true;
      emitResult(
        {
          command: state.command,
          ok: false,
          error: {
            code: first.code,
            message: state.errors.map((error) => error.message).join('\n'),
          },
        },
        { json: jsonRequested },
      );
    } else if (!state.emitted && !helpRequested && argv.length > 0) {
      state.emitted = true;
      emitResult(
        {
          command: state.command,
          ok: false,
          error: { code: 'USAGE', message: 'A command is required.' },
        },
        { json: jsonRequested },
      );
    }
  } catch {
    if (!state.emitted) {
      emitApplicationFailure(state, jsonRequested);
    }
  }
}

/**
 * binds parser diagnostics to one invocation while sharing immutable routes
 * @param state invocation-local parser and result ownership
 * @param registry the registered drivers the help describes
 * @returns configured Stricli application
 */
function createApplication(
  state: ExecutionState,
  registry: DriverRegistry,
): Application<InvocationContext> {
  return buildApplication(
    withRootHelpFooter(
      buildRouteMap({
        routes: commandRoutes,
        docs: { brief: 'manage persistent coding workstations' },
      }),
      rootHelpFooter(registry),
    ),
    {
      name: 'open-agent',
      versionInfo: { currentVersion: OPEN_AGENT_VERSION },
      localization: { text: applicationText(state) },
      scanner: { caseStyle: 'allow-kebab-for-camel' },
      documentation: {
        caseStyle: 'convert-camel-to-kebab',
        onlyRequiredInUsageLine: true,
      },
    },
  );
}

/**
 * refuses machine output combined with human-only help or version output
 * @param state invocation-local result ownership
 */
function emitJsonWithHelpFailure(state: ExecutionState): void {
  state.emitted = true;
  emitResult(
    {
      command: state.command,
      ok: false,
      error: {
        code: 'USAGE',
        message: '--json cannot be combined with help or version.',
      },
    },
    { json: true },
  );
}

/**
 * emits one generic failure when application setup or parsing throws
 * @param state invocation-local result ownership
 * @param jsonRequested selected output mode
 */
function emitApplicationFailure(
  state: ExecutionState,
  jsonRequested: boolean,
): void {
  state.emitted = true;
  emitResult(
    {
      command: state.command,
      ok: false,
      error: {
        code: 'UNEXPECTED',
        message: 'The command could not complete safely.',
      },
    },
    { json: jsonRequested },
  );
}

/**
 * appends environment guidance after Stricli's complete root command table
 * @param root supported route map with the built-in help formatter
 * @param footer root-only help text
 * @returns equivalent route map with a root-only help footer
 */
function withRootHelpFooter(
  root: RouteMap<InvocationContext>,
  footer: string,
): RouteMap<InvocationContext> {
  return {
    ...root,
    formatHelp: (args) => `${root.formatHelp(args).trimEnd()}\n\n${footer}\n`,
  };
}

/**
 * describes the environment each registered provider reads
 * @param registry the registered drivers
 * @returns the environment and documentation guidance after the command table
 */
function rootHelpFooter(registry: DriverRegistry): string {
  return `ENVIRONMENT
${Object.values(registry.providers)
  .map(
    ({ displayName, prerequisites: { credential } }) =>
      `  ${credential.environment.padEnd(ENVIRONMENT_NAME_WIDTH)} ${displayName} credential; --provider-token-source selects another source.`,
  )
  .join('\n')}
  OPEN_AGENT_*        Driver and option selection; see open-agent create --help.
  CI, NON_INTERACTIVE Disable prompts when set to 1, true, yes, or on.
  NO_COLOR            Disable color unless --color is selected.

LEARN MORE
${Object.values(registry.providers)
  .flatMap(({ prerequisites: { documentation } }) => documentation)
  .map((link) => `  ${link}`)
  .join('\n')}`;
}
