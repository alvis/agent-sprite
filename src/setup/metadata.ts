import { summarizeProfile } from '#drivers/providers/recorded';

import type { SetupSection } from '#command/contracts';
import type { ProfileSummary } from '#core/profile';
import type { WorkstationRecord } from '#drivers/contracts';
import type { RecordedProfile } from '#drivers/providers/recorded';

import type { SetupContext } from './context.js';

/**
 * records setup readiness and the persisted profile summary in provider
 * metadata; a run that changes only options the summary omits, such as the
 * update due interval, leaves the metadata as it is
 * @param section setup area that completed
 * @param context provider, workstation, persisted profile and whether this run changed it
 * @returns the workstation as recorded after setup
 */
export async function recordSetupMetadata(
  section: SetupSection,
  context: SetupContext,
): Promise<WorkstationRecord> {
  const { provider, workstation } = context;
  const isComplete = section === 'all';
  const summary = summarizeProfile(context.profile);
  if (
    !isComplete &&
    (!context.persistsProfile ||
      isSameSummary(workstation.metadata.profile, summary))
  ) {
    return workstation;
  }

  return provider.setMetadata(workstation, {
    setup: isComplete ? 'ready' : workstation.metadata.setup,
    profile: summary,
  });
}

/**
 * compares the recorded summary with the one this run would record
 * @param recorded summary the provider holds, when it holds one
 * @param summary summary of the profile this run applies
 * @returns whether recording would change nothing
 */
function isSameSummary(
  recorded: RecordedProfile | undefined,
  summary: ProfileSummary,
): boolean {
  return (
    recorded?.provider === summary.provider &&
    recorded.agent === summary.agent &&
    recorded.network === summary.network &&
    recorded.harnesses.length === summary.harnesses.length &&
    recorded.harnesses.every((id, index) => id === summary.harnesses[index])
  );
}
