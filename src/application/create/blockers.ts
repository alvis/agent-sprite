import { providerPreflight } from '#application/catalog/preflight';
import { machineNameProblem } from '#application/machine';
import { prerequisiteDetails } from '#domain/prerequisites';
import { promptUnavailableDetail } from '#kernel/operation';

import type { ResolvedInputs } from '#application/input/types';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { PrerequisiteProblem } from '#domain/prerequisites';
import type { CommandErrorCode } from '#kernel/faults';

import type { CreatePreparation } from './context';

/**
 * reports missing inputs, an invalid workstation name and provider
 * prerequisite problems together, before any provider call
 * @param dependencies the registered drivers, what this computer provides
 * @param input resolved create inputs
 * @returns the INPUT failure, or undefined when nothing blocks provisioning
 */
export async function inputFailure(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  input: ResolvedInputs,
): Promise<CreatePreparation | undefined> {
  const { credential } =
    dependencies.registry.providers[input.profile.provider].prerequisites;
  const prerequisites = await providerPreflight(
    { registry: dependencies.registry, host: dependencies.host },
    input.profile.provider,
    {
      token: input.providerToken,
      source: input.sources[credential.environment],
    },
  );
  const nameProblem = input.name ? machineNameProblem(input.name) : undefined;
  const invalid = nameProblem ? [nameProblem] : [];
  if (
    input.missing.length === 0 &&
    invalid.length === 0 &&
    prerequisites.length === 0
  ) {
    return undefined;
  }

  return blockedPreparation(
    'INPUT',
    inputFailureMessage(input.missing, invalid),
    {
      details: missingCreateDetails(
        [...input.missing, ...invalid],
        prerequisites,
      ),
    },
  );
}

/**
 * summarises what blocks provisioning before any provider call
 * @param missing required inputs unresolved before provider work
 * @param invalid supplied inputs that cannot be used
 * @returns the headline of the INPUT failure
 */
function inputFailureMessage(
  missing: readonly string[],
  invalid: readonly string[],
): string {
  if (missing.length > 0) {
    return 'Required provisioning inputs are missing';
  }

  return invalid.length > 0
    ? 'Provisioning inputs are invalid'
    : 'Provider prerequisites are missing or misconfigured';
}

/**
 * aggregates missing inputs, provider prerequisite problems and the actual
 * implicit prompt blocker into one failure
 * @param missing required inputs unresolved, or supplied but invalid, before provider work
 * @param prerequisites problems the provider preflight found, each with its fix
 * @returns safe details for the typed INPUT failure
 */
function missingCreateDetails(
  missing: readonly string[],
  prerequisites: readonly PrerequisiteProblem[],
): string[] {
  const promptHint = promptUnavailableDetail();

  return [
    ...missing,
    ...prerequisiteDetails(prerequisites),
    ...(promptHint ? [promptHint] : []),
  ];
}

/**
 * returns a structured preflight outcome before any workstation exists
 * @param code machine-readable preflight status
 * @param message safe explanation for the caller
 * @param extra optional collision or missing-input detail
 * @param extra.machine exact machine name when a collision occurred
 * @param extra.details aggregate missing inputs when preflight failed
 * @returns a non-successful create preparation
 */
export function blockedPreparation(
  code: CommandErrorCode,
  message: string,
  extra: { machine?: string; details?: string[] } = {},
): CreatePreparation {
  return {
    kind: 'result',
    result: {
      command: 'create',
      ok: false,
      error: { code, message, ...extra },
    },
  };
}
