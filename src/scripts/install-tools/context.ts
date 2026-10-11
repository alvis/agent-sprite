import { execFileSync } from 'node:child_process';
import { openSync, writeSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveTrustedFile } from '../native-files.js';

import type { StdioOptions } from 'node:child_process';

export const directory = '/opt/agent-sprite';
export const home = '/home/agent';
const systemPath = '/usr/sbin:/usr/bin:/sbin:/bin';
const environment = {
  ...process.env,
  PATH: systemPath,
  DEBIAN_FRONTEND: 'noninteractive',
};
const commandTimeoutMs = 1_200_000;
const downloadTimeoutMs = 120_000;
const lockDescriptor = 9;
const privateMode = 0o600;
const installationMask = 0o022;
process.umask(installationMask);
const shell = await resolveTrustedFile('/bin/sh');
const bootstrap = await resolveTrustedFile(`${directory}/bootstrap-node.sh`);
execFileSync(shell, [bootstrap], {
  env: environment,
  stdio: [
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    lockDescriptor,
  ],
  timeout: commandTimeoutMs,
});
export const log = openSync(`${directory}/install-tools.log`, 'a', privateMode);
export const temporary = await mkdtemp(join(tmpdir(), 'agent-sprite-install-'));
/**
 * runs root-controlled tools with the inherited ownership descriptor
 * @param executable fixed absolute system executable
 * @param args direct process arguments
 * @param capture whether the caller consumes bounded output
 * @returns captured text or an empty string
 */
export async function run(
  executable: string,
  args: string[],
  capture = false,
): Promise<string> {
  const trusted = await resolveTrustedFile(executable);
  const stdio: StdioOptions = [
    'ignore',
    capture ? 'pipe' : log,
    log,
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    lockDescriptor,
  ];
  writeSync(log, `Running ${executable}\n`);

  return execFileSync(trusted, args, {
    env: environment,
    stdio,
    encoding: 'utf8',
    timeout: commandTimeoutMs,
  });
}

/**
 * reads public release metadata with an explicit transport deadline
 * @param url official release endpoint
 * @returns complete successful response text
 */
export async function downloadText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(downloadTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Release request failed (status ${response.status})`);
  }

  return response.text();
}

/**
 * stores a public tool archive only in the private installation directory
 * @param url official release asset URL
 * @param name local archive filename
 */
export async function download(url: string, name: string): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(downloadTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Release download failed (status ${response.status})`);
  }
  await writeFile(
    join(temporary, name),
    Buffer.from(await response.arrayBuffer()),
  );
}

/**
 * replaces a manager-owned symlink without following its existing target
 * @param target installed manager-owned target
 * @param path fixed managed link
 */
export async function link(target: string, path: string): Promise<void> {
  await rm(path, { force: true });
  await symlink(target, path);
}
