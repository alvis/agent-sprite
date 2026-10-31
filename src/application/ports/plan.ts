import type { OsRelease } from '#domain/guest';
import type { GuestEnvironment } from '#domain/observations/environment';
import type { GuestNetworkIdentity } from '#domain/observations/network';
import type { WorkstationProfile } from '#domain/profile';
import type {
  RefusedSource,
  Resolution,
  ToolOwner,
  ToolSpec,
} from '#domain/tools';

import type { ProviderDriver } from './drivers';
import type { OsFamily } from './os';
import type { GuestSession, SessionCommand } from './session';

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
type StepStatus =
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

/** what a plan runs with */
export interface PlanRunParams {
  /** the steps, in any order their needs allow */
  steps: readonly SetupStep[];
  /**
   * opens a session; after a transport fault it is opened again naming the
   * lost session, whose shell and command the new one ends
   * @param supersedes pid of the lost session's shell
   * @returns the open session
   */
  openSession: (supersedes?: number) => Promise<GuestSession>;
  /** receives each step's start, retry and outcome */
  onProgress?: (event: PlanProgress) => void;
  /** attempts a step retried on transport faults gets; 3 when absent */
  attempts?: number;
  /**
   * steps an earlier plan in the same session ran to success, left out of
   * this one as they stand unchanged; a need naming one is met
   */
  settled?: readonly string[];
}

/** the provider facts a plan is assembled from */
export type PlanProvider = Pick<
  ProviderDriver,
  'id' | 'capabilities' | 'serviceBackend' | 'awakeAsset' | 'bootHookStep'
>;

/** what a plan is assembled from */
export interface AssemblyParams {
  /** the provider the workstation runs on */
  provider: PlanProvider;
  /** the profile setup applies */
  profile: WorkstationProfile;
  /** the guest's release, as the session probed it */
  release: OsRelease;
  /** sources the guest turned down, such as formulae without a bottle */
  refused?: readonly RefusedSource[];
  /** the running open-agent version */
  version: string;
  /** when setup started, as an ISO 8601 timestamp */
  setupAt: string;
  /** the retained network device identity of an earlier setup */
  networkIdentity?: GuestNetworkIdentity;
}

/** a workstation's assembled setup plan */
export interface SetupAssembly {
  /** the guest's OS family */
  family: OsFamily;
  /** every tool setup resolved */
  tools: readonly ToolSpec[];
  /** the source picked for each tool, or why none is usable */
  resolutions: readonly Resolution[];
  /** the environment the plan writes, its setup still incomplete */
  environment: GuestEnvironment;
  /** steps every package step builds on: guest libraries, boot hook, accounts, bootstrap packages, Homebrew and sysctl */
  foundation: readonly SetupStep[];
  /** the steps after the foundation: tools, idle governor and environment.json */
  steps: readonly SetupStep[];
  /** the services and cron jobs the backend installs and starts, in a plan of their own once the steps succeeded */
  services: readonly SetupStep[];
}
