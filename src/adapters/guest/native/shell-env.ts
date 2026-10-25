import {
  USER,
  ensurePrivateDirectory,
  writeAccountFile,
} from '#adapters/guest/platform/account';
import { accountHome } from '#adapters/guest/platform/layout';
import { runGuestResult } from '#adapters/guest/platform/run';
import { CommandFault } from '#kernel/faults';
import { rememberSecret } from '#kernel/redaction';

import type { NativeAccountOwner } from '#adapters/guest/platform/account';
import type { GuestChannel } from '#application/ports/guest-channel';

/** where, inside an account's home, the shells' variables are kept */
const SHELL_ENV_FILE = '.config/open-agent/env.sh';

/** the startup files zsh, bash and every POSIX login shell read, inside an account's home */
const STARTUP_FILES = ['.zshenv', '.profile', '.bashrc'] as const;

/** the line each startup file gains, marked so a rerun recognizes it */
const SOURCE_LINE = `if [ -r "$HOME/${SHELL_ENV_FILE}" ]; then . "$HOME/${SHELL_ENV_FILE}"; fi # open-agent env`;

/**
 * the program, run as the account, that prints a startup file, nothing when
 * it is absent, and fails on a link, which is left to its owner
 */
const READ_PROGRAM = [
  'if test -L "$1"; then exit 3; fi',
  'if test -e "$1"; then cat -- "$1"; fi',
].join('\n');

/** how a single quote is written inside a single-quoted shell word */
const QUOTED_QUOTE = `'\\''`;

/** the exit status of the read program for a startup file that is a link */
const LINKED_STATUS = 3;

/**
 * writes the runtime variables into each account's private shell env file,
 * which every shell of the account reads through its startup files, all in
 * the account's home so they survive a reboot; a startup file that is a
 * link is left as it is
 * @param guest target guest, running over a setup session
 * @param environment approved runtime variables, registered for redaction
 * @param shellAccounts provider shell accounts besides the agent account
 */
export async function configureShellEnv(
  guest: GuestChannel,
  environment: Record<string, string>,
  shellAccounts: readonly string[],
): Promise<void> {
  const contents = renderShellEnv(environment);
  for (const user of [USER, ...shellAccounts]) {
    const home = accountHome(user);
    const owner = { user, shellAccounts };
    await ensurePrivateDirectory(guest, `${home}/.config`, owner);
    await ensurePrivateDirectory(guest, `${home}/.config/open-agent`, owner);
    await writeAccountFile(guest, owner, {
      path: `${home}/${SHELL_ENV_FILE}`,
      contents,
    });
    if (Object.keys(environment).length) {
      for (const name of STARTUP_FILES) {
        await hookStartupFile(guest, `${home}/${name}`, owner);
      }
    }
  }
}

/**
 * renders the variables as POSIX `export` lines, each value single-quoted;
 * each quoted value is registered for redaction, since a value with a quote
 * no longer appears verbatim in the file
 * @param environment approved runtime variables with shell-safe names
 * @returns the shell env file's contents
 */
function renderShellEnv(environment: Record<string, string>): string {
  const exports = Object.entries(environment).map(([name, value]) => {
    const quoted = value.replaceAll("'", QUOTED_QUOTE);
    rememberSecret(quoted);

    return `export ${name}='${quoted}'`;
  });

  return ['# open-agent: variables from --env-file', ...exports, ''].join('\n');
}

/**
 * appends the line that reads the shell env file to a startup file that
 * lacks it, reading and writing it as its account
 * @param guest target guest
 * @param path absolute startup file path inside the account's home
 * @param owner account that owns the startup file
 */
async function hookStartupFile(
  guest: GuestChannel,
  path: string,
  owner: NativeAccountOwner,
): Promise<void> {
  const current = await readStartupFile(guest, path, owner.user);
  if (current === undefined || current.includes(SOURCE_LINE)) {
    return;
  }
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await writeAccountFile(guest, owner, {
    path,
    contents: `${current}${separator}${SOURCE_LINE}\n`,
  });
}

/**
 * reads a startup file as its account, so no link it controls is followed by root
 * @param guest target guest
 * @param path absolute startup file path
 * @param user account that owns the file
 * @returns the file's contents, empty when absent, or undefined for a link
 */
async function readStartupFile(
  guest: GuestChannel,
  path: string,
  user: string,
): Promise<string | undefined> {
  const result = await runGuestResult(
    guest,
    [
      '/usr/sbin/runuser',
      '-u',
      user,
      '--',
      '/bin/sh',
      '-c',
      READ_PROGRAM,
      'oa-read-startup',
      path,
    ],
    { step: 'shell startup file read' },
  );
  if (result.exitCode === LINKED_STATUS) {
    return undefined;
  }
  if (result.exitCode !== 0) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Reading ${path} as ${user} exited with status ${result.exitCode}`,
    });
  }

  return result.stdout;
}
