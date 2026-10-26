import { stdout } from 'node:process';

import {
  buildApplication,
  buildCommand,
  buildRouteMap,
  FlagNotFoundError,
} from '@stricli/core';
import { describe, expect, it, vi } from 'vitest';

import { pairingFlags } from '#cli/flags';
import {
  applicationText,
  parseApplication,
  requestedCommand,
} from '#cli/parser';

import { dependencies } from '../mocks/dependencies';

import type { Application } from '@stricli/core';

import type { ExecutionState, InvocationContext } from '#cli/parser';

interface ParsedCreate {
  name?: string;
  withPairCode?: boolean;
}

vi.mock('@stricli/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stricli/core')>();

  const run: typeof actual.run = async (application, inputs, context) => {
    await runnerControl();

    return actual.run(application, inputs, context);
  };

  return {
    ...actual,
    run,
  } satisfies Partial<typeof import('@stricli/core')>;
});

const runnerControl = vi.hoisted(() =>
  vi.fn<() => ReturnType<(typeof import('@stricli/core'))['run']>>(
    async () => undefined,
  ),
);

/**
 * builds a create route through the production parser hooks
 * @param state invocation-local parser diagnostics
 * @param parsed receives the flags the command handler observed
 * @returns application with one value-taking flag and the pairing flag
 */
function createApplication(
  state: ExecutionState,
  parsed: ParsedCreate[],
): Application<InvocationContext> {
  return buildApplication(
    buildRouteMap({
      routes: {
        create: buildCommand({
          parameters: {
            flags: {
              ...pairingFlags,
              name: {
                kind: 'parsed',
                parse: String,
                optional: true,
                brief: 'NAME · workstation name',
              },
            },
          },
          docs: { brief: 'create a workstation' },
          /**
           * records the flags the scanner delivered
           * @param flags parsed create flags
           */
          func(this: InvocationContext, flags: ParsedCreate): void {
            parsed.push(flags);
          },
        }),
      },
      docs: { brief: 'parser fixture' },
    }),
    {
      name: 'open-agent',
      localization: { text: applicationText(state) },
      scanner: { caseStyle: 'allow-kebab-for-camel' },
    },
  );
}

/**
 * parses one invocation through the production alias rewrite
 * @param argv command-line arguments after the executable name
 * @returns observed flags and parser diagnostics
 */
async function parse(
  argv: string[],
): Promise<{ parsed: ParsedCreate[]; state: ExecutionState }> {
  const parsed: ParsedCreate[] = [];
  const state: ExecutionState = { emitted: false, command: null, errors: [] };
  await parseApplication({
    application: createApplication(state, parsed),
    argv,
    context: { state, dependencies },
  });

  return { parsed, state };
}

describe('fn:parseApplication', () => {
  it('should rewrite a per-agent pairing alias that stands as its own flag', async () => {
    const { parsed, state } = await parse([
      'create',
      '--name',
      'devbox',
      '--with-t3-pair-code',
    ]);

    expect(state.errors).toEqual([]);
    expect(parsed).toEqual([{ name: 'devbox', withPairCode: true }]);
  });

  it('should leave a pairing alias that follows a value-taking flag as typed', async () => {
    const { parsed, state } = await parse([
      'create',
      '--name',
      '--with-t3-pair-code',
    ]);
    const messages = state.errors.map(({ message }) => message).join('\n');

    expect(parsed).toEqual([]);
    expect(state.errors).toEqual([expect.objectContaining({ code: 'USAGE' })]);
    expect(messages).toContain('--with-t3-pair-code');
    expect(messages).not.toContain('--with-pair-code');
  });

  it('should rewrite an alias that follows an inline flag value', async () => {
    const { parsed, state } = await parse([
      'create',
      '--name=devbox',
      '--with-t3-pair-code',
    ]);

    expect(state.errors).toEqual([]);
    expect(parsed).toEqual([{ name: 'devbox', withPairCode: true }]);
  });

  it.each([
    {
      label: 'removed no-pair',
      argv: ['--no-pair'],
      message: '--no-pair was removed',
    },
    {
      label: 'removed include-pairing',
      argv: ['--include-pairing'],
      message: '--include-pairing was removed',
    },
    {
      label: 'removed no-include-pairing',
      argv: ['--no-include-pairing'],
      message: '--no-include-pairing was removed',
    },
    {
      label: 'negated pair code',
      argv: ['--no-with-pair-code'],
      message: '--no-with-pair-code is not supported',
    },
    {
      label: 'negated agent pair code',
      argv: ['--no-with-t3-pair-code'],
      message: '--no-with-t3-pair-code is not supported',
    },
    {
      label: 'double negation',
      argv: ['--no-no-color'],
      message: '--no-no-color is invalid',
    },
    {
      label: 'opposing color flags',
      argv: ['--color', '--no-color'],
      message: '--color and --no-color are mutually exclusive',
    },
    {
      label: 'opposing harness flags',
      argv: ['--claude-plugins', '--no-claude-plugins'],
      message:
        '--claude-plugins and --no-claude-plugins are mutually exclusive',
    },
  ])('should reject $label before scanning', async ({ argv, message }) => {
    const { parsed, state } = await parse(['create', ...argv]);

    expect(parsed).toEqual([]);
    expect(state.errors).toEqual([
      { code: 'USAGE', message: expect.stringContaining(message) },
    ]);
  });

  it('should report an unknown flag as a usage error', async () => {
    const { parsed, state } = await parse(['create', '--with-pair-cod']);

    expect(parsed).toEqual([]);
    expect(state.errors).toEqual([expect.objectContaining({ code: 'USAGE' })]);
    expect(state.errors[0]?.message).toContain('--with-pair-cod');
  });

  it('should show root help for an empty invocation', async () => {
    let output = '';
    vi.spyOn(stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);

      return true;
    });
    const { state } = await parse([]);

    expect(state.errors).toEqual([]);
    expect(output).toContain('create');
  });

  it('should stop flag validation and alias conversion at the argument separator', async () => {
    const { state } = await parse(['create', '--', '--no-pair']);

    expect(state.errors).toEqual([expect.objectContaining({ code: 'USAGE' })]);
    expect(state.errors[0]?.message).not.toContain('was removed');
  });

  it('should suppress incidental command writes to the parser stdout stream', async () => {
    const state: ExecutionState = { emitted: false, command: null, errors: [] };
    using writing = vi.spyOn(stdout, 'write').mockImplementation(() => true);
    const application = buildApplication(
      buildRouteMap({
        routes: {
          create: buildCommand({
            parameters: {},
            docs: { brief: 'stdout fixture' },
            func(this: InvocationContext): void {
              this.process.stdout.write('incidental command output');
            },
          }),
        },
        docs: { brief: 'stdout fixture' },
      }),
      { name: 'open-agent' },
    );

    await parseApplication({
      application,
      argv: ['create'],
      context: { state, dependencies },
    });

    expect(state.errors).toEqual([]);
    expect(writing).not.toHaveBeenCalled();
  });

  it('should record an external runner rejection without printing a stack', async () => {
    let output = '';
    vi.spyOn(stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);

      return true;
    });
    runnerControl.mockRejectedValueOnce(new Error('external runner failed'));

    const { parsed, state } = await parse(['create']);

    expect({ parsed, errors: state.errors, output }).toEqual({
      parsed: [],
      errors: [{ code: 'UNEXPECTED', message: 'external runner failed' }],
      output: '',
    });
  });
});

describe('fn:requestedCommand', () => {
  it.each(['create', 'setup', 'list', 'show', 'terminate', 'doctor'] as const)(
    'should recognize %s as a command',
    (command) => {
      expect(requestedCommand([command])).toBe(command);
    },
  );

  it('should leave unrecognized input without an invented command', () => {
    expect(requestedCommand(['unsupported'])).toBeNull();
    expect(requestedCommand([])).toBeNull();
  });
});

describe('fn:applicationText', () => {
  it('should convert parser suggestions into accepted kebab-case flags', () => {
    const state: ExecutionState = { emitted: false, command: null, errors: [] };
    const text = applicationText(state);

    expect(
      text.exceptionWhileParsingArguments(
        new FlagNotFoundError('withPairCod', [
          'withPairCode',
          'localCredentials',
        ]),
        false,
      ),
    ).toBe('');
    expect(state.errors).toEqual([
      {
        code: 'USAGE',
        message: expect.stringContaining(
          '--with-pair-code or --local-credentials',
        ),
      },
    ]);
  });

  it('should preserve an alias configuration error without suggesting user flags', () => {
    const state: ExecutionState = { emitted: false, command: null, errors: [] };
    const error = new FlagNotFoundError('x', ['withPairCode'], 'x');

    expect(
      applicationText(state).exceptionWhileParsingArguments(error, false),
    ).toBe('');
    expect(state.errors).toEqual([{ code: 'USAGE', message: error.message }]);
  });

  it('should classify non-scanner parsing exceptions as unexpected', () => {
    const state: ExecutionState = { emitted: false, command: null, errors: [] };

    expect(
      applicationText(state).exceptionWhileParsingArguments(
        new Error('parser broke'),
        false,
      ),
    ).toBe('');
    expect(state.errors).toMatchObject([
      { code: 'UNEXPECTED', message: 'parser broke' },
    ]);
  });

  it('should record failures from integration hooks and flags', () => {
    const state: ExecutionState = { emitted: false, command: null, errors: [] };
    const text = applicationText(state);

    expect(
      text.exceptionWhileRunningIntegrationHook({
        exception: new Error('hook failed'),
        hook: 'beforeCommand',
        integration: 'fixture',
        ansiColor: false,
      }),
    ).toBe('');
    expect(
      text.exceptionWhileRunningIntegrationFlag({
        exception: new Error('flag failed'),
        integration: 'fixture',
        ansiColor: false,
      }),
    ).toBe('');
    expect(state.errors).toMatchObject([
      { code: 'UNEXPECTED', message: 'hook failed' },
      { code: 'UNEXPECTED', message: 'flag failed' },
    ]);
  });

  it('should format a caught exception without exposing a stack', () => {
    const state: ExecutionState = { emitted: false, command: null, errors: [] };

    expect(
      applicationText(state).formatException?.(new Error('parser failed')),
    ).toBe('parser failed');
    expect(state.errors).toEqual([]);
  });
});
