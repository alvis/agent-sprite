import { proxySelectionLabel, selectionLabel } from '#domain/selection-inputs';

import { isDriverId } from './selection';

import type { ProductDeclarations } from '#domain/declarations';
import type { HarnessId } from '#domain/ids';

import type { ProfileOptions, ProfileViolation } from '../profile';

/** a whole-number option's bound */
interface OptionBound {
  /** option key */
  key: keyof ProfileOptions;
  /** how the caller names the option */
  label: string;
  /** smallest valid value */
  minimum: number;
  /** largest valid value, when the option has one */
  maximum?: number;
  /** unit used in the violation message */
  unit: 'minutes' | 'days' | 'CPUs' | 'GB';
}

/** longest update due interval: one year */
export const MAX_UPDATE_DUE_DAYS = 365;

/** whole-number option bounds checked by validation */
export const OPTION_BOUNDS: readonly OptionBound[] = [
  {
    key: 'idleTimeoutMinutes',
    label: selectionLabel('idleTimeoutMinutes'),
    minimum: 0,
    unit: 'minutes',
  },
  {
    key: 'holdMaxMinutes',
    label: selectionLabel('holdMaxMinutes'),
    minimum: 1,
    unit: 'minutes',
  },
  {
    key: 'updateDueIntervalDays',
    label: selectionLabel('updateDueIntervalDays'),
    minimum: 1,
    maximum: MAX_UPDATE_DUE_DAYS,
    unit: 'days',
  },
  {
    key: 'minCpus',
    label: selectionLabel('minCpus'),
    minimum: 1,
    unit: 'CPUs',
  },
  {
    key: 'minMemoryGb',
    label: selectionLabel('minMemoryGb'),
    minimum: 1,
    unit: 'GB',
  },
];

/**
 * checks option bounds and that every enabled option has a declaring driver
 * @param declarations the data every registered driver declares
 * @param options requested options
 * @param selected the requested network and known requested harnesses
 * @param selected.network requested network id, possibly unknown
 * @param selected.harnesses known requested harness ids
 * @returns violations for out-of-bound or capability-less options
 */
export function optionViolations(
  declarations: ProductDeclarations,
  options: ProfileOptions,
  selected: { network: string; harnesses: readonly HarnessId[] },
): ProfileViolation[] {
  const { network, harnesses } = selected;

  return [
    ...(options.isExitNodeEnabled &&
    isDriverId(declarations, 'networks', network) &&
    !declarations.networks[network].supportsExitNode
      ? [
          {
            code: 'undeclared-capability' as const,
            message: `${selectionLabel('isExitNodeEnabled')} needs a network that supports exit nodes; "${network}" does not`,
            fields: ['network' as const, 'isExitNodeEnabled' as const],
          },
        ]
      : []),
    ...(options.isProxyEnabled &&
    !harnesses.some((id) => declarations.harnesses[id].supportsProxy)
      ? [
          {
            code: 'undeclared-capability' as const,
            message: `${proxySelectionLabel(declarations)} needs a selected harness that supports CLIProxyAPI`,
            fields: ['harnesses' as const, 'isProxyEnabled' as const],
          },
        ]
      : []),
    ...OPTION_BOUNDS.filter(
      ({ key, minimum, maximum }) =>
        !Number.isSafeInteger(options[key]) ||
        Number(options[key]) < minimum ||
        Number(options[key]) > (maximum ?? Number.MAX_SAFE_INTEGER),
    ).map(({ key, label, minimum, maximum, unit }) => ({
      code: 'invalid-option' as const,
      message: `${label} must be a whole number of ${unit} ${
        maximum === undefined
          ? `of at least ${String(minimum)}`
          : `from ${String(minimum)} to ${String(maximum)}`
      }`,
      fields: [key],
    })),
  ];
}
