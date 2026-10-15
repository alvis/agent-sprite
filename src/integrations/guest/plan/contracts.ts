import type { ToolOwner } from '#tools/contracts';

import type { SessionCommand } from '../session/contracts.js';

/** a step command; the account and timeout default to the step's */
export type StepCommand = Omit<SessionCommand, 'account' | 'timeoutMs'> &
  Partial<Pick<SessionCommand, 'account' | 'timeoutMs'>>;

/** one typed unit of host-driven setup */
export interface SetupStep {
  /** identifier, unique within the plan */
  id: string;
  /** component the step installs or configures, as setup reports it */
  component: string;
  /** account the step's commands run as unless one names its own */
  account: ToolOwner;
  /** steps that must have succeeded first */
  needs: readonly string[];
  /** exits 0 when the step's effect is already in place, so apply is skipped */
  check?: StepCommand;
  /** makes the step's effect; it must be safe to rerun */
  apply: StepCommand;
  /** exits 0 when the effect applied is in place */
  verify?: StepCommand;
  /** limit of each of the step's commands unless one names its own */
  timeoutMs: number;
  /** a failed critical step stops the plan; a failed optional one is recorded and skipped */
  critical: boolean;
  /** `transport` reruns the step from its check after a transport fault; `never` does not */
  retry: 'transport' | 'never';
}

/** how one step ended */
export type StepStatus =
  /** the check found the effect in place */
  | 'satisfied'
  /** apply ran and verify, if any, passed */
  | 'applied'
  /** a command failed or exited non-zero */
  | 'failed'
  /** a step it needs did not succeed, or the plan stopped first */
  | 'skipped';

/** the outcome of one step */
export interface StepOutcome {
  /** the step */
  step: SetupStep;
  /** how it ended */
  status: StepStatus;
  /** attempts it took, counting the first */
  attempts: number;
  /** why it failed or was skipped */
  reason?: string;
}

/** what the plan runner reports while it works */
export type PlanProgress =
  | {
      /** a step's attempt started */
      kind: 'step-started';
      /** the step */
      step: SetupStep;
      /** its attempt, counting from 1 */
      attempt: number;
    }
  | {
      /** a transport fault ended an attempt that will be retried */
      kind: 'step-retrying';
      /** the step */
      step: SetupStep;
      /** the attempt that failed */
      attempt: number;
      /** the transport fault */
      reason: string;
    }
  | {
      /** a step ended */
      kind: 'step-finished';
      /** its outcome */
      outcome: StepOutcome;
    };

/** the outcome of a whole plan */
export interface PlanReport {
  /** true unless a critical step failed */
  isComplete: boolean;
  /** every step's outcome, in the order the plan ran them */
  steps: readonly StepOutcome[];
}
