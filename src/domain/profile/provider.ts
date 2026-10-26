import { largestMachine, pickMachine } from '#domain/machine-sizes';
import { selectionLabel } from '#domain/selection-inputs';

import type { ProductDeclarations } from '#domain/declarations';
import type { ProviderId } from '#domain/ids';

import type {
  ProfileField,
  ProfileOptions,
  ProfileValidationOptions,
  ProfileViolation,
} from '../profile';

/**
 * checks the requests only a provider's declared capabilities allow
 * @param declarations the data every registered driver declares
 * @param selected the known provider id and the requested option values
 * @param selected.provider known provider id
 * @param selected.options the requested option values
 * @param options requests validated alongside the profile
 * @returns violations the selected provider's declarations raise
 */
export function providerViolations(
  declarations: ProductDeclarations,
  selected: { provider: ProviderId; options: ProfileOptions },
  options: ProfileValidationOptions,
): ProfileViolation[] {
  const { provider, options: candidateOptions } = selected;
  const { keepAwakeMode, maxAwakeDeadlineMinutes } =
    declarations.providers[provider].capabilities;
  const awakeOptions = [
    'idleTimeoutMinutes',
    'holdMaxMinutes',
  ] as const satisfies ReadonlyArray<keyof ProfileOptions>;

  return [
    ...(options.isIdleTimeoutRequested && keepAwakeMode === 'none'
      ? [
          {
            code: 'undeclared-capability' as const,
            message: `${selectionLabel('idleTimeoutMinutes')} needs a provider that keeps workstations awake; "${provider}" does not`,
            fields: ['provider', 'idleTimeoutMinutes'] as ProfileField[],
          },
        ]
      : []),
    ...machineViolations(declarations, provider, candidateOptions),
    ...(maxAwakeDeadlineMinutes === null
      ? []
      : awakeOptions
          .filter((key) => candidateOptions[key] > maxAwakeDeadlineMinutes)
          .map((key) => ({
            code: 'undeclared-capability' as const,
            message: `${selectionLabel(key)} of ${String(candidateOptions[key])} minutes is more than provider "${provider}" can keep a workstation awake: at most ${String(maxAwakeDeadlineMinutes)} minutes`,
            fields: ['provider', key] as ProfileField[],
          }))),
  ];
}

/**
 * checks the minimum machine size against the machines the provider offers
 * @param declarations the data every registered driver declares
 * @param provider known provider id
 * @param options requested options
 * @returns a violation naming the provider's largest machine when none meets the minimums
 */
export function machineViolations(
  declarations: ProductDeclarations,
  provider: ProviderId,
  options: ProfileOptions,
): ProfileViolation[] {
  const { displayName, machines } = declarations.providers[provider];
  const { minCpus, minMemoryGb } = options;
  if (
    !Number.isSafeInteger(minCpus) ||
    !Number.isSafeInteger(minMemoryGb) ||
    pickMachine(machines, { cpus: minCpus, memoryGb: minMemoryGb })
  ) {
    return [];
  }
  const largest = largestMachine(machines);

  return [
    {
      code: 'undeclared-capability',
      message: `${displayName} offers no machine with ${String(minCpus)} CPUs and ${String(minMemoryGb)} GB; it offers at most ${String(largest.cpus)} CPUs and ${String(largest.memoryGb)} GB`,
      fields: ['provider', 'minCpus', 'minMemoryGb'],
    },
  ];
}
