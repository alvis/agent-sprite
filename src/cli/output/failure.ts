import { projectFields, same } from './fields';

import type { CommandError } from '#application/failures';
import type { CommandErrorCode } from '#kernel/faults';

/** the error a failed command reports; the serializer redacts its text */
export interface ErrorOutput {
  code: CommandErrorCode;
  message: string;
  machine?: string;
  machineId?: string;
  setupIncomplete?: boolean;
  details?: string[];
  outcome?: 'retained' | 'absent' | 'unknown';
}

/**
 * projects a command error
 * @param error internal error
 * @returns output error
 */
export function projectError(error: CommandError): ErrorOutput {
  return projectFields<CommandError, ErrorOutput>(error, {
    code: same,
    message: same,
    machine: same,
    machineId: same,
    setupIncomplete: same,
    details: same,
    outcome: same,
  });
}
