import { buildApplication, buildCommand, buildRouteMap } from '@stricli/core';
import { describe, expect, it } from 'vitest';

import { pairingFlags } from '#cli/flags';
import { applicationText, parseApplication } from '#cli/parser';

import { dependencies } from '../mocks/dependencies';

import type { Application } from '@stricli/core';

import type { ExecutionState, InvocationContext } from '#cli/parser';

interface ParsedCreate {
  name?: string;
  withPairCode?: boolean;
}

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
  await parseApplication(createApplication(state, parsed), argv, {
    state,
    dependencies,
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
});
