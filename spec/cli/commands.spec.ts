import { buildApplication, buildRouteMap, run } from '@stricli/core';
import { describe, expect, it, vi } from 'vitest';

import { commandRoutes } from '#cli/commands';
import { execute } from '#cli/execute';
import { PROVIDER_IDS } from '#domain/ids';

import { dependencies } from '../mocks/dependencies';

import type { StricliProcess } from '@stricli/core';

import type { InvocationContext } from '#cli/parser';

vi.mock(
  '#cli/execute',
  () =>
    ({
      execute: vi.fn<typeof execute>(async () => undefined),
    }) satisfies Partial<typeof import('#cli/execute')>,
);

const executeCommand = vi.mocked(execute);

const application = buildApplication(
  buildRouteMap({ routes: commandRoutes, docs: { brief: 'route fixture' } }),
  { name: 'open-agent', scanner: { caseStyle: 'allow-kebab-for-camel' } },
);

/**
 * routes one invocation through the production commands and Stricli's scanner
 * @param argv command-line arguments after the executable name
 * @returns everything Stricli printed and its exit status
 */
async function route(argv: string[]): Promise<{
  output: string;
  exitCode: StricliProcess['exitCode'];
}> {
  const chunks: string[] = [];
  const write = (text: string): void => {
    chunks.push(text);
  };
  const stricliProcess: StricliProcess = {
    stdout: { write },
    stderr: { write },
  };
  const context: InvocationContext = {
    process: stricliProcess,
    state: { emitted: false, command: null, errors: [] },
    dependencies,
  };

  await run(application, argv, context);

  return { output: chunks.join(''), exitCode: stricliProcess.exitCode };
}

describe('provider flag on workstation commands', () => {
  it.each(['list', 'show', 'doctor', 'terminate'])(
    'should list --provider with every provider choice in %s help',
    async (command) => {
      const { output, exitCode } = await route([command, '--help']);

      expect(exitCode).toBe(0);
      expect(output).toContain('--provider PROVIDER');
      expect(output).toContain(`PROVIDER · ${PROVIDER_IDS.join(', ')}`);
    },
  );

  it.each(['list', 'show', 'doctor', 'terminate'])(
    'should refuse an unknown provider for %s before the command runs',
    async (command) => {
      const { output, exitCode } = await route([
        command,
        '--provider',
        'bogus',
      ]);

      expect(exitCode).not.toBe(0);
      expect(output).toContain('bogus');
    },
  );
});

describe('command route dispatch', () => {
  it.each([
    {
      argv: ['create', '--name', 'new-box', '--claude-plugin', 'alpha'],
      command: 'create',
      machine: undefined,
      options: {
        name: 'new-box',
        harnessPlugins: {
          claude: expect.objectContaining({ plugins: ['alpha'] }),
        },
      },
    },
    {
      argv: ['setup', 'dev-box', '--disable-codex-plugin', 'old'],
      command: 'setup',
      machine: 'dev-box',
      options: {
        harnessPlugins: {
          codex: expect.objectContaining({ disablePlugins: ['old'] }),
        },
      },
    },
    {
      argv: ['list', '--provider', 'sprite'],
      command: 'list',
      machine: undefined,
      options: { provider: 'sprite' },
    },
    {
      argv: ['show', 'dev-box', '--inspect'],
      command: 'show',
      machine: 'dev-box',
      options: { inspect: true },
    },
    {
      argv: ['terminate', 'dev-box', '--yes'],
      command: 'terminate',
      machine: 'dev-box',
      options: { yes: true },
    },
    {
      argv: ['doctor', 'dev-box'],
      command: 'doctor',
      machine: 'dev-box',
      options: {},
    },
  ])(
    'should dispatch $command with parsed request and invocation state',
    async ({ argv, command, machine, options }) => {
      const routed = await route(argv);

      expect(routed.exitCode).toBe(0);
      expect(executeCommand).toHaveBeenCalledExactlyOnceWith({
        dependencies,
        request: {
          command,
          ...(machine === undefined ? {} : { machine }),
          options: expect.objectContaining(options),
        },
        state: { emitted: false, command: null, errors: [] },
      });
    },
  );

  it('should list every supported command in root help', async () => {
    const { output, exitCode } = await route(['--help']);

    expect(exitCode).toBe(0);
    for (const command of [
      'create',
      'setup',
      'list',
      'show',
      'terminate',
      'doctor',
    ]) {
      expect(output).toContain(`open-agent ${command} `);
    }
  });
});
