import { DEFAULT_SELECTION } from '#core/catalog';
import { agentIds, providerIds } from '#core/ids';
import { DEFAULT_PROFILE_OPTIONS, validateProfile } from '#core/profile';
import { SELECTION_INPUTS } from '#core/selection-inputs';

import { environmentReader } from './selection-sources.js';

import type {
  ProfileField,
  ProfileOptions,
  ProfileValidationOptions,
  ProfileViolation,
} from '#core/profile';
import type { SelectionField } from '#core/selection-inputs';

import type { Resolved, SelectionContext } from './selection-sources.js';

/** options a caller can select */
export type SelectableOption = Extract<SelectionField, keyof ProfileOptions>;

/** the values a caller's flags and environment supply, before prompts and defaults */
export interface SuppliedSelection {
  /** requested provider driver id */
  provider?: string;
  /** requested ACP agent driver id */
  agent?: string;
  /** requested harness driver ids */
  harnesses?: readonly string[];
  /** requested network driver id */
  network?: string;
  /** requested options */
  options: Partial<Pick<ProfileOptions, SelectableOption>>;
}

/** the options a caller can select */
const SELECTABLE_OPTIONS: readonly SelectableOption[] = [
  'agentRelease',
  'minCpus',
  'minMemoryGb',
  'isExitNodeEnabled',
  'isProxyEnabled',
  'idleTimeoutMinutes',
  'holdMaxMinutes',
  'updateCheckIntervalMinutes',
  'updateDueIntervalDays',
];

/**
 * validates what can be known before the workstation's recorded profile is:
 * catalog ids, option bounds, and each capability whose drivers are all
 * determined, because they were supplied or the catalog registers only one
 * @param supplied values a setup run supplies
 * @param requests requests validated alongside the selection
 * @returns every violation the supplied values alone raise
 */
export function suppliedSelectionViolations(
  supplied: SuppliedSelection,
  requests: Pick<ProfileValidationOptions, 'isPairingRequested'>,
): ProfileViolation[] {
  const [onlyProvider, ...otherProviders] = providerIds();
  const [onlyAgent, ...otherAgents] = agentIds();
  const provider =
    supplied.provider ??
    (otherProviders.length === 0 ? onlyProvider : undefined);
  const agent =
    supplied.agent ?? (otherAgents.length === 0 ? onlyAgent : undefined);
  const determined = new Set<ProfileField>([
    ...(provider === undefined ? [] : (['provider'] as const)),
    ...(agent === undefined ? [] : (['agent'] as const)),
    ...(supplied.harnesses === undefined ? [] : (['harnesses'] as const)),
    ...(supplied.network === undefined ? [] : (['network'] as const)),
    ...SELECTABLE_OPTIONS.filter(
      (field) => supplied.options[field] !== undefined,
    ),
  ]);
  const validation = validateProfile(
    {
      provider: provider ?? DEFAULT_SELECTION.provider,
      agent: agent ?? DEFAULT_SELECTION.agent,
      harnesses: supplied.harnesses ?? DEFAULT_SELECTION.harnesses,
      network: supplied.network ?? DEFAULT_SELECTION.network,
      options: { ...DEFAULT_PROFILE_OPTIONS, ...definedOptions(supplied) },
    },
    {
      ...requests,
      isIdleTimeoutRequested: supplied.options.idleTimeoutMinutes !== undefined,
    },
  );

  return validation.isValid
    ? []
    : validation.violations.filter(({ fields }) =>
        fields.every((field) => determined.has(field)),
      );
}

/**
 * reads every field a run owns from its flag, then the process environment,
 * then the selected env file; the provider and agent flags are always read
 * @param context flags and sources
 * @param fields fields the run owns
 * @returns the supplied values and every unreadable environment value
 */
export function readSelection(
  context: Omit<SelectionContext, 'interaction'>,
  fields: readonly SelectionField[],
): Resolved<SuppliedSelection> {
  const { options, sources } = context;
  const read = environmentReader(sources);
  const owned = (field: SelectionField): string | undefined =>
    fields.includes(field) ? SELECTION_INPUTS[field].environment : undefined;
  const unread = { value: undefined, problems: [] };
  const exitNodeEnvironment = owned('isExitNodeEnabled');
  const proxyEnvironment = owned('isProxyEnabled');
  const harnessEnvironment = owned('harnesses');
  const networkEnvironment = owned('network');
  const exitNode = exitNodeEnvironment
    ? read.flag(options.useExitNode, exitNodeEnvironment)
    : unread;
  const proxy = proxyEnvironment
    ? read.flag(options.proxy, proxyEnvironment)
    : unread;
  const numbers = readNumberOptions(options, read, owned);

  return {
    value: {
      provider: read.choice({
        flag: options.provider,
        environment: owned('provider'),
      }),
      agent: read.choice({ flag: options.agent, environment: owned('agent') }),
      harnesses: harnessEnvironment
        ? (options.harness ?? read.list(harnessEnvironment))
        : undefined,
      network: networkEnvironment
        ? read.choice({
            flag: options.network,
            environment: networkEnvironment,
          })
        : undefined,
      options: {
        agentRelease: read.choice({
          flag: options.release,
          environment: owned('agentRelease'),
        }),
        isExitNodeEnabled: exitNode.value,
        isProxyEnabled: proxy.value,
        ...numbers.value,
      },
    },
    problems: [...exitNode.problems, ...proxy.problems, ...numbers.problems],
  };
}

/** the options whose values are whole numbers of minutes, days, CPUs or gigabytes */
const NUMBER_OPTIONS = [
  'minCpus',
  'minMemoryGb',
  'idleTimeoutMinutes',
  'holdMaxMinutes',
  'updateCheckIntervalMinutes',
  'updateDueIntervalDays',
] as const satisfies readonly SelectableOption[];

type NumberOption = (typeof NUMBER_OPTIONS)[number];

/**
 * reads the whole-number options a run owns from their flags and environment
 * @param options flags of the run
 * @param read reader over the environment sources
 * @param owned names the environment variable of a field the run owns
 * @returns the supplied numbers and every unreadable value
 */
function readNumberOptions(
  options: SelectionContext['options'],
  read: ReturnType<typeof environmentReader>,
  owned: (field: SelectionField) => string | undefined,
): Resolved<Partial<Record<NumberOption, number>>> {
  const flags: Record<NumberOption, number | undefined> = {
    minCpus: options.cpu,
    minMemoryGb: options.mem,
    idleTimeoutMinutes: options.idleMinutes,
    holdMaxMinutes: options.holdMaxMinutes,
    updateCheckIntervalMinutes: options.updateCheckMinutes,
    updateDueIntervalDays: options.updateDueDays,
  };
  const resolved = NUMBER_OPTIONS.map((field) => {
    const environment = owned(field);

    return {
      field,
      ...(environment
        ? read.number(flags[field], environment)
        : { value: undefined, problems: [] }),
    };
  });

  return {
    value: Object.fromEntries(
      resolved.map(({ field, value }) => [field, value]),
    ),
    problems: resolved.flatMap(({ problems }) => problems),
  };
}

/**
 * keeps only the options a caller supplied
 * @param supplied values a caller supplied
 * @returns the supplied options without unset keys
 */
function definedOptions(
  supplied: SuppliedSelection,
): Partial<Pick<ProfileOptions, SelectableOption>> {
  return Object.fromEntries(
    SELECTABLE_OPTIONS.flatMap((field) => {
      const value = supplied.options[field];

      return value === undefined ? [] : [[field, value]];
    }),
  );
}
