const GROUP_DRAIN_TIMEOUT_MS = 60_000;
const GROUP_DRAIN_POLL_MS = 500;

/**
 * signals a process group; the one place a vanished group (ESRCH) is tolerated
 * @param pid process group leader
 * @param signal signal to send, or 0 to probe
 * @returns whether any group member still existed
 */
export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);

    return true;
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ESRCH'
    )) {
      throw error;
    }

    return false;
  }
}

/**
 * waits for every process of a finished child group, then kills any straggler
 * @param pid process group leader
 * @returns resolves once the group has no members
 */
export async function drainProcessGroup(
  pid: number | undefined,
): Promise<void> {
  if (!pid) {
    return;
  }
  const deadline = Date.now() + GROUP_DRAIN_TIMEOUT_MS;
  while (signalGroup(pid, 0)) {
    if (Date.now() >= deadline) {
      signalGroup(pid, 'SIGKILL');

      return;
    }
    await new Promise<void>((resolveDelay): void => {
      setTimeout(resolveDelay, GROUP_DRAIN_POLL_MS);
    });
  }
}
