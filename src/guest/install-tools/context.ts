import { execFileSync } from 'node:child_process';
import { openSync, writeSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readComponentOutcomes } from '../component-outcome.js';
import { GUEST_KERNEL, GUEST_ROOT } from '../guest-root.js';
import { HOMEBREW, TOOL_LINK_RECORD } from '../homebrew.js';

import { resolveTrustedFile } from '../native-files.js';
import { runChild } from '../run-child.js';

import { HOMEBREW_INSTALLER_DIRECTORY } from './homebrew.js';
import { removeLeftovers } from './leftovers.js';
import { recordLink } from './link-record.js';

import type { StdioOptions } from 'node:child_process';

export const home = '/home/agent';
const systemPath = '/usr/sbin:/usr/bin:/sbin:/bin';
const environment = {
  ...process.env,
  PATH: systemPath,
  DEBIAN_FRONTEND: 'noninteractive',
};
// the whole environment of a program the prefix's account runs: Homebrew
// never updates itself, reports analytics, prints hints or builds from source
const homebrewEnvironment = [
  `HOME=${HOMEBREW.home}`,
  `USER=${HOMEBREW.account}`,
  `LOGNAME=${HOMEBREW.account}`,
  'PATH=/usr/bin:/bin',
  'LANG=C.UTF-8',
  'NONINTERACTIVE=1',
  'HOMEBREW_NO_SUDO=1',
  'HOMEBREW_NO_AUTO_UPDATE=1',
  'HOMEBREW_NO_ANALYTICS=1',
  'HOMEBREW_NO_ENV_HINTS=1',
  'HOMEBREW_NO_BOTTLE_SOURCE_FALLBACK=1',
];
// shorter than the updater's limit for the whole run, so a slow command ends,
// and is reported, before the updater has to stop the run
const commandTimeoutMs = 1_080_000;
const downloadTimeoutMs = 120_000;
const lockDescriptor = 9;
const privateMode = 0o600;
const installationMask = 0o022;
process.umask(installationMask);
const shell = await resolveTrustedFile('/bin/sh');
const bootstrap = await resolveTrustedFile(`${GUEST_KERNEL}/bootstrap-node.sh`);
try {
  execFileSync(shell, [bootstrap, GUEST_ROOT], {
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
} catch (error) {
  // a failed Node gate is recorded as the guest-node outcome and must not stop
  // the other components, which this process can still update with the Node it
  // is running on; any earlier failure has no such record and ends the run
  if (
    (await readComponentOutcomes().catch(() => undefined))?.['guest-node']
      ?.status !== 'failed'
  ) {
    throw error;
  }
}
export const log = openSync(
  `${GUEST_ROOT}/install-tools.log`,
  'a',
  privateMode,
);
const INSTALL_DIRECTORY = 'open-agent-install-';
// a run a signal stopped never reached its own clean-up, so this run, which
// holds the same lock, removes the directories that run left behind
await removeLeftovers(
  tmpdir(),
  new RegExp(
    `^(?:${INSTALL_DIRECTORY}|${HOMEBREW_INSTALLER_DIRECTORY})[A-Za-z0-9]{6}$`,
    'u',
  ),
  0,
);
export const temporary = await mkdtemp(join(tmpdir(), INSTALL_DIRECTORY));
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
 * runs a program as the account that owns the Homebrew prefix, without
 * blocking, with a fixed environment and without the ownership descriptor
 * @param program absolute program
 * @param args direct process arguments
 * @param capture whether the caller consumes the output
 * @returns captured text or an empty string
 */
export async function runAsHomebrew(
  program: string,
  args: readonly string[],
  capture = false,
): Promise<string> {
  const runuser = await resolveTrustedFile('/usr/sbin/runuser');
  // the arguments are fixed formula names and paths, never secrets, and they
  // tell which brew step a failure belongs to
  writeSync(log, `Running ${[program, ...args].join(' ')}\n`);

  return runChild(
    runuser,
    [
      '-u',
      HOMEBREW.account,
      '--',
      '/usr/bin/env',
      '-i',
      ...homebrewEnvironment,
      program,
      ...args,
    ],
    {
      // runuser needs nothing of root's environment; env -i empties it anyway
      env: { PATH: systemPath },
      cwd: HOMEBREW.home,
      stdio: ['ignore', capture ? 'pipe' : log, log],
      timeoutMs: commandTimeoutMs,
    },
  );
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
 * replaces a manager-owned symlink without following its existing target, and
 * records one in the tool link directory for the next boot of a provider that
 * rebuilds its root filesystem
 * @param target installed manager-owned target
 * @param path fixed managed link
 */
export async function link(target: string, path: string): Promise<void> {
  await rm(path, { force: true });
  await symlink(target, path);
  await recordLink(TOOL_LINK_RECORD, target, path);
}
