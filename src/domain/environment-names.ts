import type { ProductDeclarations } from '#domain/declarations';
import type { HarnessId } from '#domain/ids';

/**
 * lists the management credentials every registered provider and network reads
 * @param declarations the data every registered driver declares
 * @returns environment variable names that hold caller-side secrets
 */
export function driverCredentialNames(
  declarations: ProductDeclarations,
): string[] {
  return [
    ...Object.values(declarations.providers).map(
      ({ prerequisites }) => prerequisites.credential.environment,
    ),
    ...Object.values(declarations.networks).flatMap(({ inputs }) =>
      inputs
        ? [inputs.management.environment, inputs.enrollment.environment]
        : [],
    ),
  ];
}

/**
 * lists the variables the given harnesses own: those their agent sets when
 * spawning them and the model-gateway variables they read
 * @param declarations the data every registered driver declares
 * @param ids harnesses whose variables are listed
 * @returns environment variable names a runtime environment must not override
 */
export function harnessEnvironmentNames(
  declarations: ProductDeclarations,
  ids: readonly HarnessId[],
): string[] {
  return ids.flatMap((id) => {
    const { spawnEnvironment, reservedEnvironment } =
      declarations.harnesses[id];

    return [...Object.keys(spawnEnvironment), ...reservedEnvironment];
  });
}
