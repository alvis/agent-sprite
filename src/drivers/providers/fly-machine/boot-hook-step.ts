import { BOOT_HOOK, BOOT_HOOK_ON_VOLUME } from './boot-layout.js';

import type {
  SetupStep,
  StepCommand,
} from '#integrations/guest/plan/contracts';

/** id of the step that installs the boot hook on the volume and prepares the guest with it */
export const BOOT_HOOK_STEP = 'boot-hook';

/** the radix chmod reads a mode in */
const OCTAL = 8;
/** longest one command of the step may take: a prepare after a rebuilt root filesystem reinstalls the recorded packages */
const BOOT_HOOK_LIMIT_MS = 900_000;

/**
 * the shell program that tells whether the hook on the volume is the one on
 * its input and a prepare would change nothing; its one argument is the hook
 */
const CHECK_PROGRAM = 'cmp -s - "$1" && /bin/sh "$1" check';

/**
 * the shell program that writes the hook on its input to the volume, root's
 * alone as the boot stub demands, then runs its prepare; its arguments are
 * the hook and its mode
 */
const INSTALL_PROGRAM = [
  'umask 022',
  'install -d -m 0755 "$(dirname "$1")"',
  'cat >"$1.new"',
  'chmod "$2" "$1.new"',
  'mv -f "$1.new" "$1"',
  '/bin/sh "$1" prepare',
].join(' && ');

/** what the boot hook step is built with */
export interface BootHookStepParams {
  /** the boot hook's text, as read from the package */
  hook: string;
  /** ids of steps the boot hook step needs, such as the one installing the guest libraries it calls */
  needs?: readonly string[];
}

/**
 * builds the step that installs the boot hook on the volume, where the boot
 * stub runs it on every boot, and runs its prepare: it binds the volume's
 * directories, recreates the accounts and points apt's cache at the volume
 * before any later step installs a package
 * @param params the hook's text and the steps it needs
 * @returns a critical root step whose check and verify ask whether the hook is current and the guest prepared
 */
export function bootHookStep(params: BootHookStepParams): SetupStep {
  const { hook, needs = [] } = params;
  const input = { kind: 'text', value: hook } as const;
  const check: StepCommand = {
    argv: ['/bin/sh', '-c', CHECK_PROGRAM, 'oa-boot-hook', BOOT_HOOK_ON_VOLUME],
    input,
  };

  return {
    id: BOOT_HOOK_STEP,
    component: 'boot-hook',
    account: 'root',
    needs,
    check,
    apply: {
      argv: [
        '/bin/sh',
        '-c',
        INSTALL_PROGRAM,
        'oa-boot-hook',
        BOOT_HOOK_ON_VOLUME,
        BOOT_HOOK.mode.toString(OCTAL),
      ],
      input,
    },
    verify: check,
    timeoutMs: BOOT_HOOK_LIMIT_MS,
    critical: true,
    retry: 'transport',
  };
}
