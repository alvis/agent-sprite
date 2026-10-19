import type { MachineOffer } from '#domain/declarations';
import type { RecordedProfile } from '#domain/recorded';

/** provider-recorded progress of the current provisioning attempt */
export type WorkstationSetupState = 'ready' | 'incomplete' | 'not recorded';

/** provider-neutral record of one managed workstation */
export interface WorkstationRecord {
  /** immutable provider identity */
  id: string;
  /** user-chosen workstation name */
  name: string;
  /** provider account or organization owning the workstation */
  organization: string;
  /** creation time as an ISO 8601 timestamp */
  createdAt?: string;
  /** provider-reported run state */
  state: string;
  /** machine size the workstation runs on, when the provider reports it */
  machine?: MachineOffer;
  /** canonical ACP agent URL when the provider assigned one */
  url?: string;
  /** ownership, schema, setup state and profile summary read without waking */
  metadata: WorkstationMetadata;
}

/** compact non-secret metadata a provider stores natively */
export interface WorkstationMetadata {
  /** provider-recorded progress of the current provisioning attempt */
  setup: WorkstationSetupState;
  /** compact profile summary; absent when the provider has none recorded */
  profile?: RecordedProfile;
  /** open-agent release that last set the workstation up; absent when none is recorded */
  version?: string;
}
