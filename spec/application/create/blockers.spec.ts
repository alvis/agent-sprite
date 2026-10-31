import { describe, expect, it } from 'vitest';

import { inputFailure } from '#application/create/blockers';
import { OperationContext, withOperation } from '#kernel/operation';

import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';
import { dependencies } from '../../mocks/dependencies';

import type { ResolvedInputs } from '#application/input/types';

const invalidName = {
  name: 'invalid workstation',
  providerToken: 'test-org/1234/0123abcd/4567ef89',
  profile: DISABLED_NETWORK_PROFILE,
  runtimeEnv: {},
  sources: {},
  missing: [],
} satisfies ResolvedInputs;

describe('fn:inputFailure', () => {
  it('should report an invalid supplied hostname with the invocation prompt blocker', async () => {
    const operation = new OperationContext({
      signal: new AbortController().signal,
    });
    operation.setPromptBlocker('No interactive terminal');

    const result = await withOperation(operation, async () =>
      inputFailure(dependencies, invalidName),
    );

    expect(result).toMatchObject({
      kind: 'result',
      result: {
        ok: false,
        error: {
          code: 'INPUT',
          details: [
            expect.stringMatching(/DNS label/),
            expect.stringMatching(/No interactive terminal/),
          ],
        },
      },
    });
  });
});
