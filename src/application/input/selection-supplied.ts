import { AGENT_IDS, PROVIDER_IDS } from '#domain/ids';
import { validateProfile } from '#domain/profile';
import { selectionInputs } from '#domain/selection-inputs';

import { environmentReader } from './selection-sources';

import type { ApplicationDependencies } from '#application/ports/dependencies';
import type {
  ProfileField,
  ProfileOptions,
  ProfileValidationOptions,
  ProfileViolation,
} from '#domain/profile';
import type { SelectionField } from '#domain/selection-inputs';

import type { Resolved, SelectionContext } from './selection-sources';

/** options a caller can select */
type SelectableOption = Extract<SelectionField, keyof ProfileOptions>;

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
  'updateDueIntervalDays',
];

/**
 * validates what can be known before the workstation's recorded profile is:
 * catalog ids, option bounds, and each capability whose drivers are all
 * determined, because they were supplied or the catalog registers only one
 * @param dependencies the registered drivers, the profile defaults
 * @param supplied values a setup run supplies
 * @param requests requests validated alongside the selection
 * @returns every violation the supplied values alone raise
 */
export function suppliedSelectionViolations(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults'>,
  supplied: SuppliedSelection,
  requests: Pick<ProfileValidationOptions, 'isPairingRequested'>,
): ProfileViolation[] {
  const [onlyProvider, ...otherProviders]: readonly string[] = PROVIDER_IDS;
  const [onlyAgent, ...otherAgents]: readonly string[] = AGENT_IDS;
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
    dependencies.registry,
    {
      provider: provider ?? dependencies.defaults.selection.provider,
      agent: agent ?? dependencies.defaults.selection.agent,
      harnesses:
        supplied.harnesses ?? dependencies.defaults.selection.harnesses,
      network: supplied.network ?? dependencies.defaults.selection.network,
      options: {
        ...dependencies.defaults.options,
        ...definedOptions(supplied),
      },
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
 * reads every field a run owns from its flag, then the selected credential file,
 * then the process environment; the provider and agent flags are always read
 * @param dependencies the registered drivers, which declare the selection inputs
 * @param context flags and sources
 * @param fields fields the run owns
 * @returns the supplied values and every unreadable environment value
 */
export function readSelection(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  context: Omit<SelectionContext, 'interaction'>,
  fields: readonly SelectionField[],
): Resolved<SuppliedSelection> {
  const { options, sources } = context;
  const read = environmentReader(sources);
  const inputs = selectionInputs(dependencies.registry);
  const owned = (field: SelectionField): string | undefined =>
    fields.includes(field) ? inputs[field].environment : undefined;
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
