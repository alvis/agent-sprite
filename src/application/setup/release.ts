import { publishStatus, traceStage } from '#kernel/operation';

import { isReleaseChanged } from './integrations';

import type { SetupSection } from '#application/contracts';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { Interaction } from '#application/ports/interaction';
import type { SetupSession } from '#application/ports/session';
import type { ReleaseChannels } from '#domain/declarations';
import type { GuestEnvironment } from '#domain/observations/environment';
import type { WorkstationProfile } from '#domain/profile';
import type { StatusUpdate } from '#kernel/status';

/** the named inputs of isAgentReleaseChanged */
export interface ReleaseChangeParams {
  /** targeted setup area */
  section: SetupSection;
  /** the session the section applies over */
  connection: SetupSession;
  /** channel over that session, which asks the running agent what it serves */
  guest: GuestChannel;
  /** active prompts, which report a drift or a release that cannot be read */
  interaction?: Interaction;
  /** the recorded state and the validated profile */
  resolved: {
    /** what the machine records, when it records anything */
    environment: GuestEnvironment | undefined;
    /** the profile the machine records */
    recorded: WorkstationProfile;
    /** the validated profile this run applies */
    profile: WorkstationProfile;
  };
}

/** what the guest tells of the agent against its channel */
interface ReleaseDrift {
  /** whether the agent is stopped and reinstalled at its channel's release */
  isDrifted: boolean;
  /** what the run reports about it: the versions of a drift, or why none could be told */
  note?: StatusUpdate;
}

/**
 * tells whether this run moves the agent's installed release: the selection
 * names another channel, or, for the agent and all sections on a guest that
 * already records a setup, the agent drifted from its channel. The recorded
 * channel is the desired state, and the guest is asked only when the agent
 * declares release channels
 * @param dependencies the registered drivers, the guest mechanics
 * @param params the section, the session, its channel, the prompts and the resolved state
 * @returns whether the agent is stopped and moved to its channel's current release
 */
export async function isAgentReleaseChanged(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  params: ReleaseChangeParams,
): Promise<boolean> {
  const { section, resolved, interaction } = params;
  const { environment, recorded, profile } = resolved;
  if (isReleaseChanged(profile, recorded)) {
    return true;
  }
  const isAgentTargeted = section === 'agent' || section === 'all';
  const releaseChannels =
    dependencies.registry.agents[profile.agent].releaseChannels;
  if (!isAgentTargeted || !environment || !releaseChannels) {
    return false;
  }
  const drift = await traceStage({
    stage: 'setup.release',
    action: async () =>
      agentReleaseDrift(dependencies, { ...params, releaseChannels }),
  });
  if (drift.note) {
    publishStatus(drift.note, interaction);
  }

  return drift.isDrifted;
}

/**
 * compares the agent's installed version with the one its channel names now
 * and with the one the running agent serves, which differs once the updater
 * moved the agent without restarting it. A channel the registry could not be
 * asked about is no drift, so the agent keeps running and the plan's own
 * check decides whether to install it
 * @param dependencies the registered drivers, the guest mechanics
 * @param params the session, its channel, the profile and declared release channels
 * @returns whether the agent drifted, and what to report about it
 */
async function agentReleaseDrift(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  params: ReleaseChangeParams & { releaseChannels: ReleaseChannels },
): Promise<ReleaseDrift> {
  const { releaseChannels } = params;
  const { profile } = params.resolved;
  const { displayName } = dependencies.registry.agents[profile.agent];
  const channel =
    profile.options.agentRelease ?? releaseChannels.defaultChannel;
  const release = await dependencies.guest.tools.inspectAgentRelease(
    params.connection,
    profile,
  );
  if (release.status === 'untracked') {
    return { isDrifted: false };
  }
  if (release.status === 'unknown') {
    return {
      isDrifted: false,
      note: {
        kind: 'warning',
        message: `Could not read the ${channel} release of ${displayName} (${release.reason}); it keeps running`,
      },
    };
  }
  const environment = await dependencies.guest.native.inspectAgentEnvironment(
    params.guest,
    profile.agent,
  );
  const served = environment?.ok ? environment.serverVersion : undefined;
  const { installed, tagged } = release;
  if (installed === tagged && (served === undefined || served === installed)) {
    return { isDrifted: false };
  }

  return {
    isDrifted: true,
    note: {
      kind: 'info',
      message: `${displayName} has ${installed ?? 'no version'} installed and serves ${served ?? 'nothing'}, while its ${channel} channel names ${tagged}; restarting it on ${tagged}`,
    },
  };
}
