import { readFileSync } from 'node:fs';
import process from 'node:process';

import { buildApplication, buildRouteMap } from '@stricli/core';

import { commandRoutes } from './commands.js';
import { emitResult } from './execute.js';
import {
  applicationText,
  parseApplication,
  requestedCommand,
} from './parser.js';

import type { Application, RouteMap } from '@stricli/core';

import type { ExecutionState, InvocationContext } from './parser.js';

const ROOT_HELP_FOOTER = `ENVIRONMENT
  SPRITES_TOKEN       Fly Sprites token; --sprites-token-source selects another source.
  CI, NON_INTERACTIVE Disable prompts when set to 1, true, yes, or on.
  NO_COLOR            Disable color unless --color is selected.

LEARN MORE
  https://docs.fly.io/sprites/cli/authentication
  https://docs.fly.io/sprites/quickstart`;

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
        docs: { brief: 'manage persistent coding workstations on Fly Sprites' },
      }),
    ),
    {
      name: 'agent-sprite',
      versionInfo: {
        currentVersion: (
          JSON.parse(
            readFileSync(
              new URL('../../package.json', import.meta.url),
              'utf8',
            ),
          ) as { version: string }
        ).version,
      },
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
