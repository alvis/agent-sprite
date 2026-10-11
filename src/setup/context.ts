import type { CommandOptions, Interaction } from '#command/contracts';
import type { ResolvedInputs } from '#input/types';
import type { GuestIntegrations } from '#integrations/guest/types';
import type { TailnetExitNode } from '#integrations/tailscale';

/** records whether guest mutations began during this setup invocation */
export interface SetupProgress {
  started: boolean;
}

/** shared options and mutation state for one setup run */
export interface SetupContext {
  options: CommandOptions;
  interaction?: Interaction;
  input: ResolvedInputs;
  integrations: GuestIntegrations;
  tailscaleEnrolled: boolean;
  initialInstallation: boolean;
  verifiedExitNode?: TailnetExitNode;
  mutation: SetupProgress;
}
