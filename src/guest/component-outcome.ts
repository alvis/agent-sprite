import { readFile, rename, writeFile } from 'node:fs/promises';

import { GUEST_ROOT } from './guest-root.js';
import { isRecord } from './records.js';

/** what one install run did to a component */
export type ComponentStatus = 'installed' | 'skipped' | 'failed';

/** the recorded result of one component in one install run */
export interface ComponentOutcome {
  /** whether the run installed the component, found it current, or failed it */
  status: ComponentStatus;
  /** bare dotted version the component is at after the run, when known */
  version?: string;
  /** safe, fixed reason a component failed; the details stay in the private install log */
  error?: string;
}

/** where an install run leaves its outcomes, keyed by manifest component name */
export const OUTCOMES_PATH = `${GUEST_ROOT}/install-outcomes.json`;

const STATUSES: readonly unknown[] = ['installed', 'skipped', 'failed'];

/**
 * validates outcomes at the file and manifest boundary
 * @param value untrusted decoded outcomes
 * @returns whether every entry is a well-formed outcome
 */
export function isComponentOutcomes(
  value: unknown,
): value is Record<string, ComponentOutcome> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        isRecord(entry) &&
        STATUSES.includes(entry.status) &&
        (entry.version === undefined || typeof entry.version === 'string') &&
        (entry.error === undefined || typeof entry.error === 'string'),
    )
  );
}

/**
 * reads the outcomes the last install run left on the guest
 * @returns the outcomes, or nothing when no run has left any
 * @throws {Error} when the file exists but is malformed
 */
export async function readComponentOutcomes(): Promise<
  Record<string, ComponentOutcome> | undefined
> {
  const contents = await readFile(OUTCOMES_PATH, 'utf8').catch(
    (error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    },
  );
  if (contents === undefined) {
    return undefined;
  }
  const decoded: unknown = JSON.parse(contents);
  if (!isComponentOutcomes(decoded)) {
    throw new Error('Component install outcomes are malformed');
  }

  return decoded;
}

/**
 * leaves the outcomes of an install run for the updater to record
 * @param outcomes what the run did to each component, keyed by component
 */
export async function writeComponentOutcomes(
  outcomes: Record<string, ComponentOutcome>,
): Promise<void> {
  const pending = `${OUTCOMES_PATH}.new`;
  await writeFile(pending, `${JSON.stringify(outcomes, null, 2)}\n`, {
    mode: 0o644,
  });
  await rename(pending, OUTCOMES_PATH);
}
