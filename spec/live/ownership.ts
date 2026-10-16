import { LIVE_RUN_ID, PRODUCT, RETIRED_PRODUCT } from './identity.js';

import type { WorkstationIdentity } from './providers.js';

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
  /** live run whose prefix must contain the name */
  runId: string;
  /** label every managed workstation carries */
  label: string;
}

/**
 * tells whether a workstation name belongs to the given live run
 * @param name candidate workstation name from a provider or tailnet listing
 * @param runId prefix generated for the current live run
 * @returns true only for a well-formed run id and a name inside its prefix
 */
export function isRunWorkstation(name: string, runId: string): boolean {
  return LIVE_RUN_ID.test(runId) && name.startsWith(`${runId}-`);
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
      : !isRunWorkstation(observed.name, expected.runId)
        ? `outside live run ${expected.runId}`
        : !observed.labels.includes(expected.label)
          ? `missing managed label ${expected.label}`
          : undefined;
  if (refusal) {
    throw new Error(`Refusing to delete ${observed.name}: ${refusal}`);
  }
}

/**
 * lists every observed identifier that does not belong to the product
 * @param identity labels, guest paths and schedule read from a live workstation
 * @returns violations; empty when only product identifiers are present
 */
export function foreignIdentifiers(identity: WorkstationIdentity): string[] {
  const root = `/opt/${PRODUCT}`;
  const missing = [
    ...[PRODUCT, `${PRODUCT}-schema-v1`].filter(
      (label) => !identity.labels.includes(label),
    ),
    ...[root, `/etc/cron.d/${PRODUCT}`].filter(
      (path) => !identity.guestPaths.includes(path),
    ),
    ...(identity.schedule.includes(`${root}/guest/update-gate.sh`)
      ? []
      : [`schedule without ${root}/guest/update-gate.sh`]),
  ].map((item) => `missing ${item}`);
  const foreign = [
    ...identity.labels.filter((label) => !label.startsWith(PRODUCT)),
    ...identity.guestPaths.filter((path) => path.includes(RETIRED_PRODUCT)),
    ...(identity.schedule.includes(RETIRED_PRODUCT) ? ['schedule'] : []),
  ].map((item) => `foreign ${item}`);

  return [...missing, ...foreign];
}
