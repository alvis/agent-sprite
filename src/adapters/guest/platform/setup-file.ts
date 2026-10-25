import { runGuest } from './run';

import type { GuestChannel } from '#application/ports/guest-channel';

/** the longest a setup file may run, since it may install system packages */
const SETUP_FILE_LIMIT_MS = 1_800_000;

/**
 * the root program that decodes the setup file from standard input into a
 * private file in /tmp, runs it with no input and removes it however it ends
 */
const RUN_PROGRAM = [
  'umask 077',
  'oa_setup=$(mktemp /tmp/open-agent-setup.XXXXXXXXXX) || exit 1',
  `trap 'rm -f "$oa_setup"' EXIT`,
  "trap 'exit 129' HUP INT TERM",
  'base64 -d >"$oa_setup" || exit 1',
  'chmod 0700 "$oa_setup" || exit 1',
  '"$oa_setup" </dev/null',
].join('\n');

/**
 * copies a setup file to the guest's /tmp, runs it once as root and removes
 * it, failing the setup when it exits non-zero
 * @param guest target guest, running over a setup session
 * @param contents the setup file's exact bytes
 */
export async function runSetupFile(
  guest: GuestChannel,
  contents: Buffer,
): Promise<void> {
  await runGuest(guest, ['/bin/sh', '-c', RUN_PROGRAM, 'oa-setup-file'], {
    input: contents.toString('base64'),
    timeoutMs: SETUP_FILE_LIMIT_MS,
    step: 'setup file',
  });
}
