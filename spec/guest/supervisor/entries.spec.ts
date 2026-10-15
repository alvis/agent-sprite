import { describe, expect, it } from 'vitest';

import { AGENT_HOME } from '#guest/guest-root';
import {
  AGENT_ENVIRONMENT,
  AGENT_PREFIX,
  GUEST_ACCOUNTS,
} from '#guest/supervisor/entries';

describe('const:GUEST_ACCOUNTS', () => {
  it('should switch to the agent account with an exec-style tool that leaves no watching parent', () => {
    const { prefix } = GUEST_ACCOUNTS.agent;

    expect({
      program: prefix[0],
      options: prefix.slice(1, 6),
      isWatched: prefix.some((word) => word.includes('runuser')),
    }).toEqual({
      program: '/usr/bin/setpriv',
      options: [
        '--reuid=agent',
        '--regid=agent',
        '--init-groups',
        '--reset-env',
        '--',
      ],
      isWatched: false,
    });
  });

  it('should state the whole service environment after the reset instead of inheriting any', () => {
    const [, ...afterReset] = AGENT_PREFIX.slice(AGENT_PREFIX.indexOf('--'));

    expect({
      program: afterReset[0],
      assignments: afterReset.slice(1).toSorted(),
      cwd: GUEST_ACCOUNTS.agent.cwd,
    }).toEqual({
      program: '/usr/bin/env',
      assignments: Object.entries(AGENT_ENVIRONMENT)
        .map(([name, value]) => `${name}=${value}`)
        .toSorted(),
      cwd: AGENT_HOME,
    });
  });

  it('should start root services as they are, with their own environment', () => {
    expect(GUEST_ACCOUNTS.root).toMatchObject({
      prefix: [],
      cwd: '/',
      environment: { USER: 'root', HOME: '/root' },
    });
  });
});
