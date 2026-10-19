import { NO_NETWORK } from '#domain/ids';

import type { ProfileDefaults } from '#domain/profile';

/** drivers and options chosen when nothing else chooses them; reproduces today's workstation */
export const defaults = {
  selection: {
    provider: 'sprite',
    agent: 't3',
    harnesses: ['claude', 'codex'],
    network: NO_NETWORK,
  },
  options: {
    isExitNodeEnabled: false,
    isProxyEnabled: false,
    idleTimeoutMinutes: 5,
    holdMaxMinutes: 60,
    // an update is due a day after the last successful one
    updateDueIntervalDays: 1,
    // 2 GB is the most a Fly machine can have and still suspend from memory
    minCpus: 2,
    minMemoryGb: 2,
  },
} as const satisfies ProfileDefaults;
