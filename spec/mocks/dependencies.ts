import { createDependencies } from '#composition/dependencies';

import type { ApplicationDependencies } from '#application/ports/dependencies';

/** the real wiring, over whatever modules a spec has mocked */
export const dependencies: ApplicationDependencies = createDependencies();

/**
 * the real wiring with some parts replaced
 * @param overrides parts to replace
 * @returns dependencies a workflow can run on
 */
export function dependenciesWith(
  overrides: Partial<ApplicationDependencies>,
): ApplicationDependencies {
  return { ...dependencies, ...overrides };
}
