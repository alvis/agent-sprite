import { sleep } from '../timing';

import { asRoot, DETACHED_POLL_MS } from './execution';

import type { MachineProvider } from '../providers';

/** one process of a running harness session */
export interface HarnessProcess {
  /** process id */
  pid: number;
  /** start time in clock ticks since boot, which a new process with a reused id never shares */
  startTicks: number;
  /** the file the process executes, which ends in ` (deleted)` once an install replaced it */
  executable: string;
}

/** the session process a harness session runs from its release, beside its launchers */
export const NATIVE_HARNESS = '/vendor/';

/** how long a harness session may take to start */
export const SESSION_TIMEOUT_MS = 600_000;

/**
 * starts a long-lived Codex app-server session as the agent account, the
 * process the ACP agent starts for each Codex session; its input stays open,
 * so it runs until the workstation is deleted
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the session's processes, once its native process runs
 */
export async function startHarnessSession(
  provider: MachineProvider,
  name: string,
): Promise<HarnessProcess[]> {
  await asRoot(
    provider,
    name,
    `runuser -l agent -c 'setsid nohup sh -c "sleep 1000000 | codex app-server" >/dev/null 2>&1 </dev/null &'`,
  );
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const processes = await readHarnessSession(provider, name);
    if (
      processes.some(({ executable }) => executable.includes(NATIVE_HARNESS))
    ) {
      return processes;
    }
    await sleep(DETACHED_POLL_MS);
  }
  throw new Error('The harness session did not start in time');
}

/**
 * reads the processes of the running Codex app-server sessions
 * @param provider selected provider
 * @param name exact workstation name
 * @returns every session process, ordered by id
 */
export async function readHarnessSession(
  provider: MachineProvider,
  name: string,
): Promise<HarnessProcess[]> {
  // the agent account reads its own processes' executables, which root here may not
  const listing = await asRoot(
    provider,
    name,
    `for pid in $(pgrep -u agent -f 'codex app-server'); do test -r /proc/$pid/stat && echo "$pid $(cut -d' ' -f22 /proc/$pid/stat) $(runuser -u agent -- readlink /proc/$pid/exe)"; done; true`,
  );

  return listing
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pid, startTicks, ...executable] = line.split(' ');

      return {
        pid: Number(pid),
        startTicks: Number(startTicks),
        executable: executable.join(' '),
      };
    })
    .sort((a, b) => a.pid - b.pid);
}

/**
 * describes the same session after an install replaced its release: every
 * process keeps its id and start, and the native process keeps running the
 * replaced file
 * @param session the session as it started
 * @param matching the test's own matcher for a string a pattern matches
 * @returns the processes expected afterwards
 */
export function replacedSession(
  session: readonly HarnessProcess[],
  matching: (pattern: RegExp) => unknown,
): Array<Omit<HarnessProcess, 'executable'> & { executable: unknown }> {
  return session.map(({ pid, startTicks, executable }) => ({
    pid,
    startTicks,
    executable: executable.includes(NATIVE_HARNESS)
      ? matching(replacedFile(executable))
      : executable,
  }));
}

/**
 * matches the path a process shows for a file an install replaced
 * @param executable the path while the file was in place
 * @returns a pattern for any replaced file under the same npm prefix
 */
function replacedFile(executable: string): RegExp {
  return new RegExp(
    `^${executable.slice(0, executable.indexOf('/node_modules/')).replaceAll('.', '\\.')}/.* \\(deleted\\)$`,
  );
}
