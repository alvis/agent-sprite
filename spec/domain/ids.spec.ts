import { describe, expect, it } from 'vitest';

import { registry } from '#composition/registry';
import { releaseChannelIds } from '#domain/ids';

import type { AgentDeclaration } from '#domain/declarations';

describe('fn:releaseChannelIds', () => {
  it('should offer no release choices for an agent without release channels', () => {
    const agent: AgentDeclaration<'t3', 'claude' | 'codex'> = {
      ...registry.agents.t3,
    };
    delete agent.releaseChannels;

    expect(releaseChannelIds({ ...registry, agents: { t3: agent } })).toEqual(
      [],
    );
  });
});
