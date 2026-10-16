import { parseWholeNumber } from './whole-number';

/** the smallest machine a workstation may run on; the provider picks its smallest machine that fits */
export const machineFlags = {
  cpu: {
    kind: 'parsed',
    parse: parseWholeNumber,
    optional: true,
    placeholder: 'CPUS',
    brief:
      'CPUS · fewest CPUs the machine must have, at least 1 (default 2); the provider picks its smallest machine that fits',
  },
  mem: {
    kind: 'parsed',
    parse: parseWholeNumber,
    optional: true,
    placeholder: 'GB',
    brief:
      'GB · least memory the machine must have, in whole gigabytes, at least 1 (default 2); the provider picks its smallest machine that fits',
  },
} as const;
