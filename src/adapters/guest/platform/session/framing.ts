import { randomUUID } from 'node:crypto';

import {
  SECRET_DIRECTORY,
  SECRET_PREFIX,
  SESSION_DIRECTORY,
  SESSION_LOCK,
  SESSION_PATH,
} from '#adapters/guest/platform/layout';

import { revealSecret } from '#kernel/secret';

import type { SessionCommand, StepInput } from '#application/ports/session';

/** prefix of the line that follows a command's output and carries its exit status */
const STATUS_MARKER_PREFIX = '@@open-agent-status:';

/** seconds `timeout` waits after its signal before it kills the process group */
export const KILL_GRACE_SECONDS = 10;

/** names the file a `shm-file` secret is written to */
const SECRET_FILE_VARIABLE = 'OPEN_AGENT_SECRET_FILE';

/** seconds a session waits for the lock another session holds */
export const LOCK_WAIT_SECONDS = 60;

/** exit status of a session that found a needed command missing */
export const MISSING_COMMANDS_STATUS = 69;

/** exit status of a session that cannot create its private directory */
const SESSION_DIRECTORY_STATUS = 71;

/** exit status of a session that found no writable `/dev/shm` */
export const NO_SHM_STATUS = 72;

/** exit status of a session that could not take the lock in time */
export const LOCK_BUSY_STATUS = 75;

/** exit status of a `shm-file` delivery that could not write the secret */
const SECRET_DELIVERY_STATUS = 70;

const MILLISECONDS_PER_SECOND = 1000;
/** base64 characters per here-document line */
const BASE64_LINE_LENGTH = 76;
/** closes a single-quoted word, emits an escaped quote and reopens it */
const ESCAPED_QUOTE = "'\\''";
/** a portable environment variable name */
const VARIABLE_NAME = /^[A-Za-z_]\w*$/u;
/** seconds the orphaned process group gets between its TERM and its KILL */
const ORPHAN_GRACE_SECONDS = 2;
/** `$0` of the program that decodes a command's standard input */
const INPUT_DECODER_NAME = 'open-agent-input';
/** `$0` of the program that writes a `shm-file` secret as the command's account */
const SECRET_WRITER_NAME = 'open-agent-secret';
/**
 * run as the command's account, so the secret is its own file and no
 * ownership is ever handed over: writes the decoded secret to a 0600 file in
 * a private 0700 directory under `/dev/shm`, runs the command with the file's
 * path and removes the directory when it ends, whatever ends it
 */
const SECRET_WRITER = `umask 077
oa_secret=$(mktemp -d ${SECRET_PREFIX}XXXXXXXXXX) || exit ${SECRET_DELIVERY_STATUS}
trap 'rm -rf "$oa_secret"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
base64 -d > "$oa_secret/secret" || exit ${SECRET_DELIVERY_STATUS}
${SECRET_FILE_VARIABLE}="$oa_secret/secret" "$@" </dev/null
exit $?`;

/**
 * the helpers the session's scripts call: the start time of a process, which
 * tells a live process from a reused pid; whether a recorded process group
 * still has a member; the record of the shell and its running process group,
 * replaced atomically; and the status line written after a command's output
 * on both streams
 */
export const SESSION_HELPERS = `oa_session_started() {
  sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d ' ' -f 20
}
oa_session_grouped() {
  oa_session_leader=$(oa_session_started "$1")
  if test -n "$oa_session_leader"; then
    test "$oa_session_leader" = "$2"
  else
    sed 's/.*) //' /proc/[0-9]*/stat 2>/dev/null | cut -d ' ' -f 3 | grep -qxF -- "$1"
  fi
}
oa_session_record() {
  printf '%s %s %s %s\\n' "$$" "$oa_session_self" "$1" "$2" > "$oa_session_pids.new" &&
    mv -f "$oa_session_pids.new" "$oa_session_pids"
}
oa_session_report() {
  printf '\\n%s%d\\n' "$1" "$2"
  printf '\\n%s%d\\n' "$1" "$2" >&2
}
`;

/**
 * creates the marker of one command; it is unguessable, so no command can
 * print a status line its real one would follow
 * @returns the marker, ending in the colon the status follows
 */
export function newMarker(): string {
  return `${STATUS_MARKER_PREFIX}${randomUUID()}:`;
}

/**
 * quotes one word the way a POSIX shell reads it back unchanged
 * @param word any text without a NUL
 * @returns the single-quoted word
 * @throws {Error} when the word holds a NUL, which no shell word can carry
 */
export function quoteWord(word: string): string {
  if (word.includes('\0')) {
    throw new Error('A session word cannot contain a NUL byte');
  }

  return `'${word.replaceAll("'", ESCAPED_QUOTE)}'`;
}

/**
 * runs a trusted session script in the shell itself, so what it exports,
 * defines and redirects stays with the session, then reports its status
 * @param name name of the shell function the body becomes
 * @param body the function body, which returns its status
 * @param marker the unguessable marker its status line carries
 * @returns the framed script
 */
export function inlineScript(
  name: string,
  body: string,
  marker: string,
): string {
  return `${name}() {\n${body}\n}\n${name} </dev/null\noa_session_report ${quoteWord(marker)} "$?"\n`;
}

/**
 * renders the body that prepares the session: it checks the commands it
 * needs, fixes `PATH`, `TMPDIR` and the umask, ends an orphaned process group
 * (or the group and shell of a session this one supersedes), takes the
 * root-only lock and reports its shell's pid. The recorded group is ended
 * while its leader lives with the start time recorded, or, once the leader
 * died, while any process's stat still names the group (field 5); a leader
 * that started at another time holds a reused pid, whose group the kernel
 * only allows once the recorded one has no member left
 * @param params what the session needs and whom it supersedes
 * @param params.sessionCommands programs the session runs
 * @param params.supersedes pid of a lost session of this host that this one replaces
 * @returns the function body for {@link inlineScript}
 */
export function openBody(params: {
  sessionCommands: readonly string[];
  supersedes?: number;
}): string {
  const { sessionCommands, supersedes } = params;
  const commands = sessionCommands.map(quoteWord).join(' ');
  const superseded = supersedes === undefined ? '-' : String(supersedes);

  return `oa_session_missing=
for oa_session_command in ${commands}; do
  command -v "$oa_session_command" >/dev/null 2>&1 || {
    printf 'missing:%s\\n' "$oa_session_command"
    oa_session_missing=1
  }
done
test -z "$oa_session_missing" || return ${MISSING_COMMANDS_STATUS}
test -d ${SECRET_DIRECTORY} && test -w ${SECRET_DIRECTORY} || return ${NO_SHM_STATUS}
export PATH=${SESSION_PATH}
export TMPDIR=${SECRET_DIRECTORY}
umask 022
oa_session_pids=${SESSION_DIRECTORY}/session.pids
test ! -L ${SESSION_DIRECTORY} || return ${SESSION_DIRECTORY_STATUS}
mkdir -p -m 0700 ${SESSION_DIRECTORY} && chmod 0700 ${SESSION_DIRECTORY} || return ${SESSION_DIRECTORY_STATUS}
oa_session_self=$(oa_session_started "$$")
if test -f "$oa_session_pids"; then
  read -r oa_session_shell oa_session_shell_start oa_session_group oa_session_group_start < "$oa_session_pids" || :
  oa_session_live=$(oa_session_started "\${oa_session_shell:--}")
  oa_session_end=
  if test -z "$oa_session_live" || test "$oa_session_live" != "\${oa_session_shell_start:-}"; then
    oa_session_end=orphan
  elif test "$oa_session_shell" = ${superseded}; then
    oa_session_end=superseded
  fi
  case "\${oa_session_group:--}" in
    *[!0-9]* | '') oa_session_group= ;;
  esac
  if test -n "$oa_session_end" && test -n "$oa_session_group" &&
    oa_session_grouped "$oa_session_group" "\${oa_session_group_start:--}"; then
    kill -s TERM -- "-$oa_session_group" 2>/dev/null || :
  fi
  if test "$oa_session_end" = superseded; then
    kill -s TERM "$oa_session_shell" 2>/dev/null || :
  fi
  if test -n "$oa_session_end"; then
    sleep ${ORPHAN_GRACE_SECONDS}
    test -z "$oa_session_group" ||
      ! oa_session_grouped "$oa_session_group" "\${oa_session_group_start:--}" ||
      kill -s KILL -- "-$oa_session_group" 2>/dev/null || :
  fi
fi
exec 9>"${SESSION_LOCK}" || return ${SESSION_DIRECTORY_STATUS}
flock -w ${LOCK_WAIT_SECONDS} 9 || return ${LOCK_BUSY_STATUS}
rm -rf ${SECRET_PREFIX}*
oa_session_record - -
printf 'pid:%s\\n' "$$"`;
}

/** what {@link commandScript} needs beside the command */
interface CommandFrame {
  /** the command */
  command: SessionCommand;
  /** the command's marker */
  marker: string;
  /** program prefix that runs the command as its account; empty for root */
  runAs: readonly string[];
  /** the session's shell, which decodes standard input */
  shell: string;
}

/**
 * frames one command: it runs in the background as its own session and
 * process group under `timeout -k`, without the lock descriptor, is recorded
 * so a later session can end it if this one is lost, and is waited for; its
 * status line follows its output on both streams. `setsid` makes it its
 * group's leader, so its pid is the group's id that the record keeps
 * @param frame the command, its marker, account prefix and shell
 * @returns the framed script
 */
export function commandScript(frame: CommandFrame): string {
  const { command, marker, runAs, shell } = frame;
  checkCommand(command);
  const { input } = command;
  const seconds = Math.max(
    1,
    Math.ceil(command.timeoutMs / MILLISECONDS_PER_SECOND),
  );
  const supervise = ['setsid', '-w', 'timeout', '-k']
    .map(quoteWord)
    .concat(String(KILL_GRACE_SECONDS), String(seconds));
  const variables = Object.entries(command.environment ?? {}).map(
    ([name, value]) => quoteWord(`${name}=${value}`),
  );
  const invocation = [
    ...(variables.length > 0 ? [quoteWord('env'), ...variables] : []),
    ...command.argv.map(quoteWord),
  ];
  const program = [...runAs.map(quoteWord), ...invocation];
  const record = `oa_session_pid=$!
oa_session_record "$oa_session_pid" "$(oa_session_started "$oa_session_pid")"
wait "$oa_session_pid"`;
  const report = `oa_session_status=$?
oa_session_record - -
oa_session_report ${quoteWord(marker)} "$oa_session_status"
`;

  if (input === undefined) {
    return `${[...supervise, ...program].join(' ')} 9>&- </dev/null &\n${record}\n${report}`;
  }
  const isFile = input.kind === 'secret' && input.as === 'shm-file';
  const receiver = isFile
    ? [
        ...runAs.map(quoteWord),
        ...[shell, '-c', SECRET_WRITER, SECRET_WRITER_NAME].map(quoteWord),
        ...invocation,
      ]
    : [
        ...[shell, '-c', 'base64 -d | "$@"', INPUT_DECODER_NAME].map(quoteWord),
        ...program,
      ];
  const { delimiter, body } = hereDocument(inputBytes(input));

  return `${[...supervise, ...receiver].join(' ')} 9>&- <<'${delimiter}' &\n${body}${delimiter}\n${record}\n${report}`;
}

/**
 * refuses a command the framing cannot carry exactly
 * @param command argv, environment and limit to check
 * @throws {Error} when a word holds a NUL, the program looks like an
 * assignment `env` would take, a variable name is not portable or reserved,
 * or the timeout is not a positive duration
 */
function checkCommand(command: SessionCommand): void {
  const [program] = command.argv;
  if (program === '' || program.includes('=')) {
    throw new Error(`Session program ${program} is not a program name`);
  }
  for (const [name, value] of Object.entries(command.environment ?? {})) {
    if (!VARIABLE_NAME.test(name) || name === SECRET_FILE_VARIABLE) {
      throw new Error(`Session variable ${name} cannot be set`);
    }
    quoteWord(value);
  }
  command.argv.forEach(quoteWord);
  if (!Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0) {
    throw new Error('A session command needs a positive timeout');
  }
}

/**
 * turns standard input into the bytes the here-document carries
 * @param input text, bytes or a secret the command receives
 * @returns the bytes the command reads
 */
function inputBytes(input: StepInput): Uint8Array {
  if (input.kind === 'bytes') {
    return input.value;
  }

  return Buffer.from(
    input.kind === 'text' ? input.value : revealSecret(input.value),
    'utf8',
  );
}

/**
 * encodes bytes as a base64 here-document under a random delimiter, so no
 * byte of the input is ever read as shell text
 * @param bytes the input
 * @returns the delimiter and the body, which ends in a newline
 */
function hereDocument(bytes: Uint8Array): { delimiter: string; body: string } {
  const encoded = Buffer.from(bytes).toString('base64');
  const lines: string[] = [];
  for (let start = 0; start < encoded.length; start += BASE64_LINE_LENGTH) {
    lines.push(encoded.slice(start, start + BASE64_LINE_LENGTH));
  }

  return {
    delimiter: `OPEN_AGENT_${randomUUID().replaceAll('-', '_')}`,
    body: lines.map((line) => `${line}\n`).join(''),
  };
}
