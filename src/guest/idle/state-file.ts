import { join } from 'node:path';

import { readUntrustedJson, writeAtomically } from './files.js';
import {
  GOVERNOR_STATE_FILE,
  STATE_MAX_BYTES,
  isGovernorState,
} from './state.js';

import type { GovernorReport, GovernorState } from './state.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. The state record lives in the agent-writable awake directory, so
// every reader, root included, reads it as untrusted data and validates it

/**
 * reads the governor state record as untrusted data
 * @param directory absolute awake directory
 * @param owners user ids that may own the record
 * @returns the validated record, or why none could be read
 */
export async function readGovernorState(
  directory: string,
  owners: ReadonlySet<number>,
): Promise<GovernorReport> {
  const read = await readUntrustedJson(join(directory, GOVERNOR_STATE_FILE), {
    owners,
    maxBytes: STATE_MAX_BYTES,
  });
  if ('missing' in read) {
    return { recorded: false, reason: 'no awake event has been recorded yet' };
  }
  if ('refused' in read) {
    return { recorded: false, reason: `the record is ${read.refused}` };
  }

  return isGovernorState(read.value)
    ? { recorded: true, state: read.value }
    : { recorded: false, reason: 'the record is malformed' };
}

/**
 * records the governor state atomically
 * @param directory absolute awake directory
 * @param state the state after a recompute
 */
export async function writeGovernorState(
  directory: string,
  state: GovernorState,
): Promise<void> {
  await writeAtomically(
    directory,
    GOVERNOR_STATE_FILE,
    `${JSON.stringify(state, null, 2)}\n`,
  );
}
