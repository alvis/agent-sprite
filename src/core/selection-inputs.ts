import { CLIPROXYAPI_INPUTS } from '#drivers/shared/cliproxyapi/inputs';

/** a selection step's flag and the environment variable that mirrors it */
export interface SelectionInput {
  /** command-line flag */
  flag: string;
  /** environment variable read from the process, then the selected env file */
  environment: string;
}

/** the flags and environment variables that select drivers and options */
export const SELECTION_INPUTS = {
  provider: { flag: '--provider', environment: 'OPEN_AGENT_PROVIDER' },
  agent: { flag: '--agent', environment: 'OPEN_AGENT_AGENT' },
  agentRelease: { flag: '--release', environment: 'OPEN_AGENT_RELEASE' },
  minCpus: { flag: '--cpu', environment: 'OPEN_AGENT_CPU' },
  minMemoryGb: { flag: '--mem', environment: 'OPEN_AGENT_MEM' },
  harnesses: { flag: '--harness', environment: 'OPEN_AGENT_HARNESSES' },
  network: { flag: '--network', environment: 'OPEN_AGENT_NETWORK' },
  isExitNodeEnabled: {
    flag: '--use-exit-node',
    environment: 'OPEN_AGENT_USE_EXIT_NODE',
  },
  isProxyEnabled: {
    flag: '--proxy',
    environment: CLIPROXYAPI_INPUTS.enabled.environment,
  },
  idleTimeoutMinutes: {
    flag: '--idle-minutes',
    environment: 'OPEN_AGENT_IDLE_MINUTES',
  },
  holdMaxMinutes: {
    flag: '--hold-max-minutes',
    environment: 'OPEN_AGENT_HOLD_MAX_MINUTES',
  },
  updateDueIntervalDays: {
    flag: '--update-due-days',
    environment: 'OPEN_AGENT_UPDATE_DUE_DAYS',
  },
} as const satisfies Record<string, SelectionInput>;

/** a profile field a caller can select */
export type SelectionField = keyof typeof SELECTION_INPUTS;

/**
 * names a selectable field the way the caller supplies it
 * @param field selectable profile field
 * @returns the flag followed by its environment variable
 */
export function selectionLabel(field: SelectionField): string {
  const { flag, environment } = SELECTION_INPUTS[field];

  return `${flag} (${environment})`;
}
