import { buildApplication, buildRouteMap, run } from '@stricli/core';
import { describe, expect, it } from 'vitest';

import { commandRoutes } from '#cli/commands';
import { PROVIDER_IDS } from '#domain/ids';

import { dependencies } from '../mocks/dependencies';

import type { StricliProcess } from '@stricli/core';

import type { InvocationContext } from '#cli/parser';

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
