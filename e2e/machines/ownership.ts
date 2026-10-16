import { E2E_SCOPE, PRODUCT, RETIRED_PRODUCT } from './identity';

import type { WorkstationIdentity } from './providers';

/** provider record observed immediately before a direct deletion */
export interface ObservedWorkstation {
  /** exact provider name */
  name: string;
  /** provider labels currently attached to the workstation */
  labels: readonly string[];
}

/** identity a direct deletion is allowed to remove */
export interface DeletionExpectation {
  /** exact workstation name requested by the harness */
  name: string;
  /** cleanup scope whose prefix must start the name */
  scope: string;
  /** label every managed workstation carries */
  label: string;
}

/**
 * tells whether a workstation name lies inside an e2e cleanup scope
 * @param name candidate workstation name from a provider or tailnet listing
 * @param scope `oa-e2e-` for every e2e run, or `<run id>-` for one run
 * @returns true only for a well-formed scope and a name inside it
 */
export function isScopedWorkstation(name: string, scope: string): boolean {
  return E2E_SCOPE.test(scope) && name.startsWith(scope);
}

/**
 * refuses a direct provider deletion unless name, run prefix and label all match
 * @param observed freshly fetched provider record
 * @param expected identity the harness intends to delete
 */
export function assertOwnedWorkstation(
  observed: ObservedWorkstation,
  expected: DeletionExpectation,
): void {
  const refusal =
    observed.name !== expected.name
      ? `expected exactly ${expected.name}`
      : !isScopedWorkstation(observed.name, expected.scope)
        ? `outside ${expected.scope}*`
        : !observed.labels.includes(expected.label)
          ? `missing managed label ${expected.label}`
          : undefined;
  if (refusal) {
    throw new Error(`Refusing to delete ${observed.name}: ${refusal}`);
  }
}

/**
 * lists every observed identifier that does not belong to the product
 * @param identity labels, guest paths and schedule read from a workstation
 * @returns violations; empty when only product identifiers are present
 */
export function foreignIdentifiers(identity: WorkstationIdentity): string[] {
  const root = `/opt/${PRODUCT}`;
  const missing = [
    ...identity.requiredLabels.filter(
      (label) => !identity.labels.includes(label),
    ),
    ...[root, `/etc/cron.d/${PRODUCT}`].filter(
      (path) => !identity.guestPaths.includes(path),
    ),
    ...(identity.schedule.includes(`${root}/maintenance/update-gate.sh`)
      ? []
      : [`schedule without ${root}/maintenance/update-gate.sh`]),
  ].map((item) => `missing ${item}`);
  const foreign = [
    ...identity.labels.filter((label) => !label.startsWith(PRODUCT)),
    ...identity.guestPaths.filter((path) => path.includes(RETIRED_PRODUCT)),
    ...(identity.schedule.includes(RETIRED_PRODUCT) ? ['schedule'] : []),
  ].map((item) => `foreign ${item}`);

  return [...missing, ...foreign];
}
