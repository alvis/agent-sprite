// environment.json: the one record setup leaves on the guest. The guest's sh
// programs (updater, links, service backend, launchers, governor, boot hook)
// read it with jq, and the host reads it back to inspect, update and destroy

import { CommandFault } from '#kernel/faults';
import { isRecord } from '#kernel/guards';

import { environmentProblem } from './validation';

import type { ProductDeclarations } from '#domain/declarations';
import type {
  EnvironmentSchema,
  GuestEnvironment,
} from '#domain/observations/environment';

/** the record's mode: root writes it, every account reads it */
export const ENVIRONMENT_MODE = 0o644;

/** the record's format version */
export const ENVIRONMENT_SCHEMA: EnvironmentSchema = 1;

/**
 * renders the record as the file setup writes
 * @param environment the record
 * @returns its JSON text, ending in a newline
 */
export function serializeEnvironment(environment: GuestEnvironment): string {
  return `${JSON.stringify(environment, null, 2)}\n`;
}

/**
 * reads the record back and validates it field by field
 * @param declarations the data every registered driver declares
 * @param text the file's contents
 * @returns the record
 * @throws {CommandFault} when the record has a format version this release does not know
 * @throws {Error} when the record is not JSON or is malformed
 */
export function parseEnvironment(
  declarations: ProductDeclarations,
  text: string,
): GuestEnvironment {
  const value: unknown = JSON.parse(text);
  if (
    isRecord(value) &&
    value.schema !== undefined &&
    value.schema !== ENVIRONMENT_SCHEMA
  ) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: `Guest environment format version ${JSON.stringify(value.schema)} is not supported by this open-agent release; it was left unchanged`,
    });
  }
  if (!isRecord(value) || value.schema !== ENVIRONMENT_SCHEMA) {
    throw new Error('The guest environment is malformed: it has no schema');
  }
  const problem = environmentProblem(declarations, value);
  if (problem) {
    throw new Error(`The guest environment is malformed: ${problem}`);
  }

  return value as unknown as GuestEnvironment;
}
