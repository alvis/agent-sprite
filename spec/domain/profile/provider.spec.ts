import { describe, expect, it } from 'vitest';

import { defaults } from '#composition/defaults';
import { registry } from '#composition/registry';
import { providerViolations } from '#domain/profile';

import type { ProductDeclarations } from '#domain/declarations';

describe('fn:providerViolations', () => {
  it('should require awake support for a requested idle timeout without imposing a provider deadline when none is declared', () => {
    const declarations = {
      ...registry,
      providers: {
        ...registry.providers,
        sprite: {
          ...registry.providers.sprite,
          capabilities: {
            ...registry.providers.sprite.capabilities,
            keepAwakeMode: 'none',
            maxAwakeDeadlineMinutes: null,
          },
        },
      },
    } satisfies ProductDeclarations;

    expect(
      providerViolations(
        declarations,
        {
          provider: 'sprite',
          options: {
            ...defaults.options,
            idleTimeoutMinutes: 61,
            holdMaxMinutes: 61,
          },
        },
        { isIdleTimeoutRequested: true },
      ),
    ).toMatchObject([
      {
        code: 'undeclared-capability',
        fields: ['provider', 'idleTimeoutMinutes'],
      },
    ]);
  });
});
