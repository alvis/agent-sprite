import type { ProductDeclarations } from '#domain/declarations';

/** a selection step's flag and the environment variable that mirrors it */
interface SelectionInput {
  /** command-line flag */
  flag: string;
  /** environment variable read from the process, then the selected credential file */
  environment: string;
}

/** the flags and environment variables that select drivers and options, apart from gateway routing */
const SELECTION_INPUTS = {
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
export type SelectionField = keyof typeof SELECTION_INPUTS | 'isProxyEnabled';

/** a profile field whose flag and environment variable are fixed by the product */
type FixedSelectionField = keyof typeof SELECTION_INPUTS;

/**
 * lists every selection step with the flag and environment variable it reads
 * @param declarations the data every registered driver declares; the gateway declares the variable that turns routing on
 * @returns each selectable field's flag and environment variable
 */
export function selectionInputs(
  declarations: ProductDeclarations,
): Record<SelectionField, SelectionInput> {
  return {
    ...SELECTION_INPUTS,
    isProxyEnabled: {
      flag: '--proxy',
      environment: declarations.gateways.cliproxyapi.inputs.enabled.environment,
    },
  };
}

/**
 * names a selection step the way the caller supplies it
 * @param input the step's flag and environment variable
 * @param input.flag command-line flag
 * @param input.environment environment variable that mirrors the flag
 * @returns the flag followed by its environment variable
 */
function labelOf({ flag, environment }: SelectionInput): string {
  return `${flag} (${environment})`;
}

/**
 * names a selectable field the way the caller supplies it
 * @param field selectable profile field whose flag and variable the product fixes
 * @returns the flag followed by its environment variable
 */
export function selectionLabel(field: FixedSelectionField): string {
  return labelOf(SELECTION_INPUTS[field]);
}

/**
 * names the gateway routing switch the way the caller supplies it
 * @param declarations the data every registered driver declares
 * @returns the flag followed by its environment variable
 */
export function proxySelectionLabel(declarations: ProductDeclarations): string {
  return labelOf(selectionInputs(declarations).isProxyEnabled);
}
