import type { CommandOptions, Interaction } from '#command/contracts';
import type { WorkstationProfile } from '#core/profile';
import type {
  NetworkExitNode,
  ProviderDriver,
  WorkstationRecord,
} from '#drivers/contracts';
import type { ResolvedInputs } from '#input/types';
import type { SetupConnection } from '#integrations/guest/connection';

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
  connection: SetupConnection;
  options: CommandOptions;
  interaction?: Interaction;
  input: ResolvedInputs;
  /** validated selection this run applies; the recorded one when unchanged */
  profile: WorkstationProfile;
  /** whether this run persists the selection into the stored profile */
  persistsProfile: boolean;
  /** whether this run moves the agent to another release channel */
  isReleaseChanged: boolean;
  /** whether the guest already holds a device identity on the selected network */
  networkEnrolled: boolean;
  verifiedExitNode?: NetworkExitNode;
  mutation: SetupProgress;
}
