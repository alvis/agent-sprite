import process from 'node:process';

import { buildApplication, buildRouteMap } from '@stricli/core';

import { catalog } from '#core/catalog';
import { OPEN_AGENT_VERSION } from '#utilities/version';

import { commandRoutes } from './commands';
import { emitResult } from './execute';
import { applicationText, parseApplication, requestedCommand } from './parser';

import type { Application, RouteMap } from '@stricli/core';

import type { ExecutionState, InvocationContext } from './parser';

const ENVIRONMENT_NAME_WIDTH = 19;
const ROOT_HELP_FOOTER = `ENVIRONMENT
${Object.values(catalog.providers)
  .map(
    ({ displayName, prerequisites: { credential } }) =>
      `  ${credential.environment.padEnd(ENVIRONMENT_NAME_WIDTH)} ${displayName} credential; --provider-token-source selects another source.`,
  )
  .join('\n')}
  OPEN_AGENT_*        Driver and option selection; see open-agent create --help.
  CI, NON_INTERACTIVE Disable prompts when set to 1, true, yes, or on.
  NO_COLOR            Disable color unless --color is selected.

LEARN MORE
${Object.values(catalog.providers)
  .flatMap(({ prerequisites: { documentation } }) => documentation)
  .map((link) => `  ${link}`)
  .join('\n')}`;

/**
 * appends environment guidance after Stricli's complete root command table
 * @param root supported route map with the built-in help formatter
 * @returns equivalent route map with a root-only help footer
 */
function withRootHelpFooter(
  root: RouteMap<InvocationContext>,
): RouteMap<InvocationContext> {
  return {
    ...root,
    formatHelp: (args) =>
      `${root.formatHelp(args).trimEnd()}\n\n${ROOT_HELP_FOOTER}\n`,
  };
}

/**
 * binds parser diagnostics to one invocation while sharing immutable routes
 * @param state invocation-local parser and result ownership
 * @returns configured Stricli application
 */
function createApplication(
  state: ExecutionState,
): Application<InvocationContext> {
  return buildApplication(
    withRootHelpFooter(
      buildRouteMap({
        routes: commandRoutes,
        docs: { brief: 'manage persistent coding workstations' },
      }),
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
  const jsonRequested = argv.includes('--json');
  const helpRequested = argv.some((argument) =>
    ['--help', '-h', '--version', '-v'].includes(argument),
  );
  if (jsonRequested && helpRequested) {
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
      state,
    );

    return;
  }
  try {
    await parseApplication(createApplication(state), argv, state);
    if (!state.emitted && state.errors.length > 0) {
      const first = state.errors[0]!;
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
        state,
      );
    } else if (!state.emitted && !helpRequested && argv.length > 0) {
      emitResult(
        {
          command: state.command,
          ok: false,
          error: { code: 'USAGE', message: 'A command is required.' },
        },
        { json: jsonRequested },
        state,
      );
    }
  } catch {
    if (!state.emitted) {
      emitApplicationFailure(state, jsonRequested);
    }
  }
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
    state,
  );
}
