import { catalog } from './catalog';
import { harnessDrivers, harnessIds } from './harnesses';
import { networksWithInputs } from './networks';

import type { RegisteredNetwork } from './networks';

/**
 * lists the management credentials every registered provider and network reads
 * @param networks network drivers whose inputs are read, the registered networks by default
 * @returns environment variable names that hold caller-side secrets
 */
export function driverCredentialNames(
  networks?: readonly RegisteredNetwork[],
): string[] {
  return [
    ...Object.values(catalog.providers).map(
      ({ prerequisites }) => prerequisites.credential.environment,
    ),
    ...networksWithInputs(networks).flatMap(({ inputs }) => [
      inputs.management.environment,
      inputs.enrollment.environment,
    ]),
  ];
}

/**
 * lists the variables registered harnesses own: those their agent sets when
 * spawning them and the model-gateway variables they read
 * @returns environment variable names a runtime environment must not override
 */
export function harnessEnvironmentNames(): string[] {
  return harnessDrivers(harnessIds()).flatMap(
    ({ spawnEnvironment, reservedEnvironment }) => [
      ...Object.keys(spawnEnvironment),
      ...reservedEnvironment,
    ],
  );
}
