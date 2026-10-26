import type { CommandOptions } from '#application/contracts';
import type { ResolvedInputs } from '#application/input/types';
import type {
  ProviderDriver,
  NetworkExitNode,
} from '#application/ports/drivers';
import type { Interaction } from '#application/ports/interaction';
import type { SetupSession } from '#application/ports/session';
import type { WorkstationProfile } from '#domain/profile';
import type { WorkstationRecord } from '#domain/workstation';

/** records whether guest mutations began during this setup invocation */
export interface SetupProgress {
  started: boolean;
}

/** shared options and mutation state for one setup run */
export interface SetupContext {
  /** authenticated provider hosting the workstation */
  provider: ProviderDriver;
  /** managed workstation selected for this run */
  workstation: WorkstationRecord;
  /** the root setup session the run's guest commands and plan share */
  connection: SetupSession;
  options: CommandOptions;
  interaction?: Interaction;
  input: ResolvedInputs;
  /** validated selection this run applies; the recorded one when unchanged */
  profile: WorkstationProfile;
  /** whether this run persists the selection into the stored profile */
  persistsProfile: boolean;
  /** whether this run moves the agent's installed release: to another channel, or back to its channel's current release when the guest drifted from it */
  isReleaseChanged: boolean;
  /** whether the guest already holds a device identity on the selected network */
  networkEnrolled: boolean;
  verifiedExitNode?: NetworkExitNode;
  mutation: SetupProgress;
}
