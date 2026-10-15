import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * writes one process's stat line the way Linux does, with a command name that
 * holds spaces and a parenthesis
 * @param procRoot directory standing in for `/proc`
 * @param entry the process's id, start time and state letter
 * @param entry.pid process id
 * @param entry.start start time in clock ticks, the 22nd field
 * @param entry.state the state letter, running unless given
 */
export async function writeProcess(
  procRoot: string,
  entry: { pid: number; start: number; state?: string },
): Promise<void> {
  const { pid, start, state = 'S' } = entry;
  await mkdir(join(procRoot, String(pid)), { recursive: true });
  // fields 4 to 21 precede the start time
  const before = ['1', ...Array.from({ length: 17 }, () => '0')];
  await writeFile(
    join(procRoot, String(pid), 'stat'),
    `${pid} (node a) b) ${state} ${before.join(' ')} ${start} 0 0\n`,
  );
}

/**
 * removes a process from the table, as when it exits
 * @param procRoot directory standing in for `/proc`
 * @param pid process id
 */
export async function endProcess(procRoot: string, pid: number): Promise<void> {
  await rm(join(procRoot, String(pid)), { recursive: true, force: true });
}
