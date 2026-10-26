import { describe, expect, it } from 'vitest';

import { registry } from '#composition/registry';
import { releaseViolations } from '#domain/profile';

import type { ProductDeclarations } from '#domain/declarations';

describe('fn:releaseViolations', () => {
  it('should reject a requested channel when the agent declares no channels', () => {
    const agent = { ...registry.agents.t3 };
    delete agent.releaseChannels;
    const declarations = {
      ...registry,
      agents: { ...registry.agents, t3: agent },
    } satisfies ProductDeclarations;

    expect(releaseViolations(declarations, 't3', 'stable')).toMatchObject([
      {
        code: 'undeclared-capability',
        fields: ['agent', 'agentRelease'],
      },
    ]);
  });

  it('should reject an unknown channel for an agent that declares channels', () => {
    expect(releaseViolations(registry, 't3', 'preview')).toMatchObject([
      {
        code: 'invalid-option',
        fields: ['agent', 'agentRelease'],
      },
    ]);
  });
});
