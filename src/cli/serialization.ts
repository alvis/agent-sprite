import { PairingSecret } from '#utilities/pairing-secret';
import { redactResolved } from '#utilities/redaction';

import type { CommandResult } from '#command';
import type { CommandError, CommandName } from '#command/contracts';

/** JSON values after structural disclosure and registered credential redaction */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | JsonObject;

/** a serialized output group, never a domain result escape hatch */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** versioned printable result, separated from internal pairing markers */
export type SerializedResult =
  | {
      schemaVersion: 1;
      command: CommandName;
      ok: true;
      data: JsonObject;
      error?: never;
    }
  | {
      schemaVersion: 1;
      command: CommandName | null;
      ok: false;
      error: CommandError;
      data?: JsonObject;
    };

/**
 * projects one typed outcome into the public versioned output contract
 * @param result completed domain or parser result
 * @returns printable payload with no internal output controls or secret markers
 */
export function serializeResult(result: CommandResult): SerializedResult {
  if (result.ok) {
    return {
      schemaVersion: 1,
      command: result.command,
      ok: true,
      data: serializeObject({
        ...result.data,
        retainedCredential: result.retainedCredential,
      }),
    };
  }
  const { error } = result;

  return {
    schemaVersion: 1,
    command: result.command,
    ok: false,
    error: {
      ...error,
      message: redactResolved(error.message),
      machine:
        error.machine === undefined ? undefined : redactResolved(error.machine),
      machineId:
        error.machineId === undefined
          ? undefined
          : redactResolved(error.machineId),
      details: error.details?.map((detail) => redactResolved(detail)),
    },
    data: result.data === undefined ? undefined : serializeObject(result.data),
  };
}

/**
 * narrows a serialized group for presentation without record casts
 * @param value serialized value
 * @returns whether the value is a named field group
 */
export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * sanitizes every field while preserving its public key
 * @param value typed domain object or nested SDK observation
 * @returns named JSON fields
 */
function serializeObject(value: object): JsonObject {
  const entries: Array<[string, unknown]> = Object.entries(value);

  return Object.fromEntries(
    entries.flatMap(([key, nested]) => {
      const value = serializeValue(nested);

      return value === undefined ? [] : [[redactResolved(key), value]];
    }),
  );
}

/**
 * converts nested runtime observations at the serialization boundary
 * @param value domain field or external SDK value
 * @returns safe JSON value, omitting unsupported values as JSON does
 */
function serializeValue(value: unknown): JsonValue | undefined {
  if (value instanceof PairingSecret) {
    return value.disclose(true);
  }
  if (typeof value === 'string') {
    return redactResolved(value);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value instanceof Date) {
    return value.toJSON();
  }
  if (Array.isArray(value)) {
    const values: unknown[] = value;

    return values.map((nested) => serializeValue(nested) ?? null);
  }
  if (typeof value === 'object') {
    return serializeObject(value);
  }

  return undefined;
}
