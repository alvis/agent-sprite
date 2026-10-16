import { CommandFault } from '#errors';
import { sessionAwakeHold } from '#integrations/guest/awake';

import {
  inlineScript,
  LOCK_BUSY_STATUS,
  LOCK_WAIT_SECONDS,
  MISSING_COMMANDS_STATUS,
  newMarker,
  NO_SHM_STATUS,
  openBody,
  SESSION_HELPERS,
} from './framing.js';
import { OS_PROBE_BODY, parseOsProbe } from './os-probe.js';
import { ShellSession } from './session.js';

import type { ProviderDriver, WorkstationRecord } from '#drivers/contracts';
import type { GuestExecResult, GuestProcess } from '#drivers/guest-channel';
import type { OsImage } from '#os/contracts';

import type {
  GuestSession,
  SessionAwakeHold,
  SessionFamily,
} from './contracts.js';

const MILLISECONDS_PER_SECOND = 1000;
/** longest the OS probe may take */
const PROBE_LIMIT_MS = 30_000;
/** longest the session's preparation may take beside its wait for the lock */
const OPEN_LIMIT_MS = 15_000;
/** the line the preparation reports the shell's pid on */
const PID_LINE = /^pid:(\d+)$/mu;

/** what a session is opened over */
interface GuestSessionParams {
  /** the root shell the provider opened, running the family's shell */
  shell: GuestProcess;
  /** the family the provider declared */
  family: SessionFamily;
  /** the provider's declared images */
  images: readonly OsImage[];
  /** holds the workstation awake while the session lives; a seam for the idle governor */
  awakeHold?: SessionAwakeHold;
  /** pid of a lost session of this host whose shell and command this one ends */
  supersedes?: number;
}

/** what {@link openWorkstationSession} opens a session with */
export interface WorkstationSessionParams extends Omit<
  GuestSessionParams,
  'shell' | 'images'
> {
  /** the provider that opens the root shell and declared the images */
  provider: Pick<
    ProviderDriver,
    'images' | 'awaitGuestReady' | 'openRootShell'
  >;
  /** the workstation the session runs on */
  workstation: WorkstationRecord;
}

/**
 * waits until the guest has booted, opens a root shell and opens a session
 * on it, which holds the workstation awake while its shell lives unless
 * another hold is given
 * @param params the provider, workstation, family and awake hold
 * @returns a session that holds the guest's setup lock
 */
export async function openWorkstationSession(
  params: WorkstationSessionParams,
): Promise<GuestSession> {
  const { provider, workstation, ...rest } = params;
  await provider.awaitGuestReady(workstation);
  const shell = await provider.openRootShell(workstation, rest.family.shell);

  return openGuestSession({
    awakeHold: sessionAwakeHold,
    ...rest,
    shell,
    images: provider.images,
  });
}

/**
 * opens a session on a root shell: probes the guest's OS and refuses another
 * family than the declared one, then prepares the shell, ends an orphaned
 * process group, takes the root-only lock and opens the awake hold
 * @param params the shell, family, declared images and awake hold
 * @returns a session that holds the guest's setup lock
 */
async function openGuestSession(
  params: GuestSessionParams,
): Promise<GuestSession> {
  const { shell, family, images, awakeHold, supersedes } = params;
  const session = new ShellSession(shell, family);
  try {
    const probeMarker = newMarker();
    const probe = await session.script(
      `${SESSION_HELPERS}${inlineScript('oa_session_probe', OS_PROBE_BODY, probeMarker)}`,
      probeMarker,
      PROBE_LIMIT_MS,
    );
    if (probe.exitCode !== 0) {
      throw new CommandFault({
        code: 'PREFLIGHT',
        message: `The guest has no readable OS release (status ${probe.exitCode})`,
      });
    }
    const release = parseOsProbe(probe.stdout, family, images);
    const openMarker = newMarker();
    const opened = await session.script(
      inlineScript(
        'oa_session_open',
        openBody({ sessionCommands: family.sessionCommands, supersedes }),
        openMarker,
      ),
      openMarker,
      OPEN_LIMIT_MS + LOCK_WAIT_SECONDS * MILLISECONDS_PER_SECOND,
    );
    session.start(release, openedPid(opened));
    if (awakeHold) {
      await session.holdAwake(awakeHold);
    }

    return session;
  } catch (error) {
    session.kill();
    throw error;
  }
}

/**
 * reads the shell's pid from a successful preparation
 * @param opened the preparation's exit status and report
 * @returns the pid of the session's shell
 * @throws {CommandFault} when a command is missing, `/dev/shm` is unusable,
 * another session holds the lock, or the private directory cannot be made
 */
function openedPid(opened: GuestExecResult): number {
  const { exitCode, stdout } = opened;
  if (exitCode === MISSING_COMMANDS_STATUS) {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message: 'The guest lacks commands a setup session needs',
      details: stdout
        .split('\n')
        .filter((line) => line.startsWith('missing:'))
        .map((line) => line.slice('missing:'.length)),
    });
  }
  if (exitCode === NO_SHM_STATUS) {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message: 'The guest has no writable /dev/shm for setup secrets',
    });
  }
  if (exitCode === LOCK_BUSY_STATUS) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: `Another setup session or a scheduled tool update held the guest for ${LOCK_WAIT_SECONDS} seconds`,
    });
  }
  const [, pid] = PID_LINE.exec(stdout) ?? [];
  if (exitCode !== 0 || pid === undefined) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `The guest setup session could not start (status ${exitCode})`,
    });
  }

  return Number(pid);
}
