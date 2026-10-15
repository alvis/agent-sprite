import { CommandFault } from '#errors';
import { GUEST_KERNEL, GUEST_NODE, GUEST_ROOT } from '#guest/guest-root';
import { HOMEBREW } from '#guest/homebrew';
import { checkOperation } from '#operation';
import { redactResolved } from '#utilities/redaction';

import { runGuest, runGuestResult } from '../guest.js';

import { sanitizeGuestDiagnostic } from './diagnostics.js';

import type { GuestChannel } from '#drivers/guest-channel';

interface InstallerOptions {
  script: 'install-tools.js';
  timeoutMs: number;
}

const maximumLogBytes = 131_072;
const diagnosticLimit = 512;
// a command is logged as `Running <program> [arguments]`; the Homebrew
// installer runs as `/bin/bash <script>`
const installerCommands = new Set([
  '/usr/bin/apt-get',
  HOMEBREW.brew,
  '/bin/bash',
  '/usr/bin/tar',
  '/usr/bin/install',
  '/usr/sbin/runuser',
]);
const failureLine =
  /^(?:Error(?::| \[)|npm (?:error|ERR!)|error:|fatal:|E: |curl: \(\d+\)|Component \S+ failed:)/iu;

/**
 * executes one installer and retains a useful private-log diagnostic on failure
 * @param guest exact guest whose surrounding transaction owns the log
 * @param options fixed installer script, arguments and execution deadline
 */
export async function runGuestInstaller(
  guest: GuestChannel,
  options: InstallerOptions,
): Promise<void> {
  try {
    await runGuest(guest, [GUEST_NODE, `${GUEST_KERNEL}/${options.script}`], {
      timeoutMs: options.timeoutMs,
      step: options.script,
    });
  } catch (error) {
    checkOperation();
    let diagnostic: string | undefined;
    try {
      const log = await runGuestResult(guest, [
        '/usr/bin/head',
        '-c',
        String(maximumLogBytes + 1),
        `${GUEST_ROOT}/install-tools.log`,
      ]);
      if (log.exitCode === 0) {
        diagnostic = installerFailureMessage(options.script, log.stdout);
      }
    } catch {
      checkOperation();
    }
    if (!diagnostic) {
      throw error;
    }
    throw new CommandFault({
      code: 'PROVIDER',
      message: diagnostic,
      cause: error,
      causeVisibility: 'private',
    });
  }
}

/**
 * selects a concrete failure after redacting a complete, size-bounded log
 * @param script fixed installer whose command failed
 * @param log whole log or the bounded overflow sentinel read
 * @returns safe command context and reason, or no replacement diagnostic
 */
export function installerFailureMessage(
  script: InstallerOptions['script'],
  log: string,
): string | undefined {
  if (Buffer.byteLength(log) > maximumLogBytes) {
    return undefined;
  }
  const lines = redactResolved(log)
    .split(/\r?\n/u)
    .map(sanitizeGuestDiagnostic);
  const commandLine = lines.findLastIndex(
    (line) =>
      line.startsWith('Running ') &&
      installerCommands.has(
        line.slice('Running '.length).split(' ', 1)[0] ?? '',
      ),
  );
  if (commandLine < 0) {
    return undefined;
  }
  const reason = lines
    .slice(commandLine + 1)
    .find((line) => failureLine.test(line));
  if (!reason) {
    return undefined;
  }
  const command = lines[commandLine]!.slice('Running '.length);

  return `Guest ${script} failed during ${command}: ${reason}`.slice(
    0,
    diagnosticLimit,
  );
}
