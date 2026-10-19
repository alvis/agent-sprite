import type { GuestAccount } from '#domain/guest-command';

/** privilege program every guest command and service runs behind */
export const SUDO_PROGRAM = '/usr/bin/sudo';
const SUDO_ARGUMENTS = ['-n', '-E', '--'] as const;
/** prefix dropping root privileges to the agent account */
const AGENT_PREFIX = ['/usr/sbin/runuser', '-u', 'agent', '--'] as const;

/**
 * renders a command as sudo arguments, behind runuser for the agent account;
 * exec and service registration share it so service definitions stay
 * byte-identical across runs and are never replaced spuriously
 * @param account guest account the command runs as; root when absent
 * @param program absolute path or name of the program
 * @param args program arguments
 * @returns arguments passed to sudo
 */
export function privilegedArguments(
  account: GuestAccount | undefined,
  program: string,
  args: readonly string[],
): string[] {
  return [
    ...SUDO_ARGUMENTS,
    ...(account === 'agent' ? AGENT_PREFIX : []),
    program,
    ...args,
  ];
}
