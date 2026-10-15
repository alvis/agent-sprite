import { GUEST_KERNEL, GUEST_NODE, GUEST_ROOT } from '../guest-root.js';

import { SESSION_ID, SOURCE_NAME } from './names.js';

import type { HolderProcess } from './process-identity.js';

// guest kernel: constants, types and pure functions only, with no I/O, so the
// host imports them to write the command entry; names no provider. The entry
// runs the `awake.js` module of the deployed kernel with the managed Node

/** the awake command every harness hook and managed operation runs */
export const AWAKE_COMMAND = `${GUEST_ROOT}/bin/open-agent-awake`;

/** the kernel module the awake command runs */
const AWAKE_ENTRY = `${GUEST_KERNEL}/idle/awake.js`;

/**
 * exit status of a command line without a known action: no hook ever sends
 * one, so it means a person typed the command and no turn is waiting on it
 */
export const USAGE_EXIT_CODE = 64;

/**
 * the awake module ends itself, with status 0, this long after it starts
 * unless `--budget-ms` gives a shorter run budget, so a hook never waits
 * longer than this on an awake event
 */
export const AWAKE_DEADLINE_MS = 8_000;

/**
 * the shortest run budget `--budget-ms` accepts: enough for the holder write,
 * which lands before any deadline apply starts
 */
export const AWAKE_MIN_BUDGET_MS = 1_000;

const ACTIONS = ['heartbeat', 'hold-open', 'hold-close'] as const;
/** how much of an unexpected option a refusal repeats */
const OPTION_ECHO_LENGTH = 32;
/** the `--session` value that takes the session identifier from the hook's input */
export const HOOK_SESSION_ARGUMENT = '-';
const OPTIONS = ['--source', '--session', '--budget-ms'] as const;
/** a run budget in whole milliseconds, without sign, leading zero or exponent */
const BUDGET_MS = /^[1-9]\d{0,5}$/;
const USAGE = `usage: open-agent-awake <${ACTIONS.join('|')}> --source <name> --session <id|${HOOK_SESSION_ARGUMENT}> [--budget-ms <${AWAKE_MIN_BUDGET_MS}-${AWAKE_DEADLINE_MS}>]`;

/** what an awake event reports */
export type AwakeAction = (typeof ACTIONS)[number];

/** one validated awake event */
export interface AwakeEvent {
  /** what the holder reports */
  action: AwakeAction;
  /** harness or managed operation reporting */
  source: string;
  /** session identifier; only its hash is ever stored */
  session: string;
  /**
   * the long-lived process a managed hold belongs to; a managed hold whose
   * process has ended is pruned. Only a managed operation running as root
   * reports one
   */
  process?: HolderProcess;
}

/** a parsed awake command line */
export type AwakeInvocation =
  | {
      /** the command line names no known action; the usage text */
      usage: string;
    }
  | (AwakeRunBudget &
      (
        | {
            /** the action is known but an option is missing or invalid; the reason */
            refused: string;
          }
        | {
            /** the validated event */
            event: AwakeEvent;
          }
        | {
            /** the event of a harness hook, whose session identifier is on standard input */
            hook: Omit<AwakeEvent, 'session'>;
          }
      ));

/** how long a command line with a known action may run */
export interface AwakeRunBudget {
  /**
   * milliseconds after which the command ends itself with status 0:
   * `--budget-ms` when given and valid, else AWAKE_DEADLINE_MS
   */
  budgetMs: number;
}

/**
 * writes the command entry: it runs the awake module with the managed Node,
 * lets it read the hook's input from standard input and discards both of its
 * outputs, so a hook sees nothing on either stream, and passes on only the
 * usage status, repeating the usage
 * text to the person who typed the command; a missing Node, a module that
 * fails to load or any other status becomes 0, so the entry never fails the
 * turn of the hook that runs it
 * @param node absolute path of the Node executable
 * @param entry absolute path of the awake module
 * @returns the complete script text
 */
export function awakeCommandScript(
  node: string = GUEST_NODE,
  entry: string = AWAKE_ENTRY,
): string {
  return [
    '#!/bin/sh',
    '# open-agent idle governor event; never fails the calling turn',
    `usage=$(${node} ${entry} "$@" 2>&1 >/dev/null)`,
    `[ "$?" -eq ${USAGE_EXIT_CODE} ] || exit 0`,
    `printf '%s\\n' "$usage" >&2`,
    `exit ${USAGE_EXIT_CODE}`,
    '',
  ].join('\n');
}

/**
 * parses an awake command line strictly: one action, then `--source` and
 * `--session` once each, with values of a bounded length and a safe charset
 * that holds no path separator, and at most one `--budget-ms` within
 * AWAKE_MIN_BUDGET_MS and AWAKE_DEADLINE_MS; `--session -` defers the session
 * identifier to the hook input
 * @param args command arguments after the program name
 * @returns the event or the refusal reason with the run budget, or the usage
 * text
 */
export function parseAwakeArguments(args: readonly string[]): AwakeInvocation {
  const [action, ...options] = args;
  const known = ACTIONS.find((candidate) => candidate === action);
  if (known === undefined) {
    return { usage: USAGE };
  }
  const values = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const [flag, value] = [options[index], options[index + 1]];
    const option = OPTIONS.find((candidate) => candidate === flag);
    if (option === undefined || value === undefined || values.has(option)) {
      return {
        budgetMs: AWAKE_DEADLINE_MS,
        refused: `unexpected option ${String(flag).slice(0, OPTION_ECHO_LENGTH)}`,
      };
    }
    values.set(option, value);
  }
  const budget = values.get('--budget-ms');
  const budgetMs = budget === undefined ? AWAKE_DEADLINE_MS : Number(budget);
  if (
    (budget !== undefined && !BUDGET_MS.test(budget)) ||
    budgetMs < AWAKE_MIN_BUDGET_MS ||
    budgetMs > AWAKE_DEADLINE_MS
  ) {
    return {
      budgetMs: AWAKE_DEADLINE_MS,
      refused: `--budget-ms must be ${AWAKE_MIN_BUDGET_MS} to ${AWAKE_DEADLINE_MS} milliseconds`,
    };
  }
  const source = values.get('--source');
  const session = values.get('--session');
  if (source === undefined || !SOURCE_NAME.test(source)) {
    return { budgetMs, refused: '--source must be a short lower-case name' };
  }
  if (session === HOOK_SESSION_ARGUMENT) {
    return { budgetMs, hook: { action: known, source } };
  }
  if (session === undefined || !SESSION_ID.test(session)) {
    return {
      budgetMs,
      refused:
        '--session must be - or 1 to 128 letters, digits or ._:- characters',
    };
  }

  return { budgetMs, event: { action: known, source, session } };
}
