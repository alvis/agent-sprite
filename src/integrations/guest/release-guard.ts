import { CommandFault } from '#errors';
import { ENVIRONMENT_PATH } from '#guest/guest-root';
import { isRecord } from '#utilities/guards';
import {
  compareSemver,
  isSemver,
  OPEN_AGENT_VERSION,
} from '#utilities/version';

import { runGuestResult } from '../guest.js';

import type { ProviderDriver, WorkstationRecord } from '#drivers/contracts';

/**
 * where a command learns which release set a workstation up: `metadata` never
 * wakes the guest, `guest` reads environment.json and fails when it cannot,
 * and `guest-or-metadata` falls back to the metadata when the guest is unreadable
 */
export type ReleaseSource = 'metadata' | 'guest' | 'guest-or-metadata';

/** exit status of the read when the guest records no environment */
const ABSENT_STATUS = 3;

/** longest the read of environment.json may take */
const READ_LIMIT_MS = 30_000;

/** a workstation a newer open-agent release set up, which this one must not manage */
export class NewerReleaseFault extends CommandFault {
  /** the release the workstation records */
  public readonly recorded: string;

  /**
   * names the workstation and both releases
   * @param workstation the refused workstation
   * @param recorded the release it records
   */
  constructor(workstation: WorkstationRecord, recorded: string) {
    super({
      code: 'CONFLICT',
      message: `${workstation.name} was set up by open-agent ${recorded}, newer than this open-agent ${OPEN_AGENT_VERSION}; upgrade open-agent to manage it`,
    });
    this.recorded = recorded;
  }
}

/**
 * refuses a workstation a newer open-agent release set up; a workstation
 * that records no release, or one that is not a semantic version, is not newer
 * @param provider the provider the workstation runs on
 * @param workstation record of the machine checked
 * @param source where the recorded release is read from
 * @throws {NewerReleaseFault} when the recorded release is newer than this one
 */
export async function assertSupportedRelease(
  provider: Pick<ProviderDriver, 'openGuest'>,
  workstation: WorkstationRecord,
  source: ReleaseSource,
): Promise<void> {
  const recorded =
    source === 'metadata'
      ? workstation.metadata.version
      : await guestRelease(provider, workstation, source);
  if (recorded && isNewerRelease(recorded)) {
    throw new NewerReleaseFault(workstation, recorded);
  }
}

/**
 * tells whether a recorded release is newer than this one
 * @param recorded release a workstation records
 * @returns true only for a semantic version above this release
 */
export function isNewerRelease(recorded: string): boolean {
  return isSemver(recorded) && compareSemver(recorded, OPEN_AGENT_VERSION) > 0;
}

/**
 * reads the release environment.json records with one guest command
 * @param provider the provider that opens the guest channel
 * @param workstation record of the machine read
 * @param source whether an unreadable guest falls back to the metadata
 * @returns the recorded release, or nothing when the guest records none
 * @throws {CommandFault} when the guest cannot be read and no fallback is allowed
 */
async function guestRelease(
  provider: Pick<ProviderDriver, 'openGuest'>,
  workstation: WorkstationRecord,
  source: Exclude<ReleaseSource, 'metadata'>,
): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await runGuestResult(
      await provider.openGuest(workstation),
      [
        'sh',
        '-c',
        `test -e "$1" || exit ${ABSENT_STATUS}; cat "$1"`,
        'open-agent-release',
        ENVIRONMENT_PATH,
      ],
      { timeoutMs: READ_LIMIT_MS },
    );
    if (exitCode === ABSENT_STATUS) {
      return undefined;
    }
    if (exitCode !== 0) {
      throw new CommandFault({
        code: 'PROVIDER',
        message: `The guest's ${ENVIRONMENT_PATH} could not be read`,
      });
    }

    return recordedRelease(stdout);
  } catch (error) {
    if (source === 'guest-or-metadata') {
      return workstation.metadata.version;
    }
    throw error;
  }
}

/**
 * reads the release out of environment.json leniently, so a record whose
 * format a newer release changed still names that release
 * @param text the file's contents
 * @returns the release, or nothing when the record names none
 */
function recordedRelease(text: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const openAgent = isRecord(value) ? value.openAgent : undefined;
  const version = isRecord(openAgent) ? openAgent.version : undefined;

  return typeof version === 'string' ? version : undefined;
}
