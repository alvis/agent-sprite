import {
  SUPERVISOR_LOG,
  SUPERVISOR_MAIN,
  SUPERVISOR_NODE,
} from './protocol.js';

// pure: the host renders the supervisor's command entry, which the installer
// writes root-owned and private; the provider's init runs it as root. It names
// no provider and imports only other guest code

/** seconds the entry waits before it starts a supervisor that exited again */
const RESTART_SECONDS = 5;

/** what the entry runs and where it records what happened */
export interface SupervisorEntryParams {
  /** the managed Node executable */
  node: string;
  /** the supervisor's compiled main module */
  main: string;
  /** the supervisor's log */
  log: string;
}

/** closes a single-quoted word, adds an escaped quote and reopens it */
const QUOTE_ESCAPE = String.raw`'\''`;

/** the entry's interpreter line, shell options and fixed environment */
const ENTRY_HEADER = `#!/bin/sh
# open-agent guest supervisor entry, rendered from src/guest/supervisor/. The
# provider's init runs it as root; it never runs a file another account could
# replace.
set -u
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C

`;

/** the entry's functions and its restart loop, after the assignments */
const ENTRY_BODY = `child=
pause=

# writes one line to the log and to the console
note() {
  line="open-agent-supervisor $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\\n' "$line" >>"$log" 2>/dev/null
  printf '%s\\n' "$line"
}

# succeeds when the path and every directory above it belong to root and no
# other account may write them; a link must be root's, and its own mode bits
# say nothing
root_controlled() {
  path=$1
  while :; do
    facts=$(stat -c '%u %a' -- "$path") || return 1
    test "\${facts%% *}" = 0 || return 1
    if ! test -L "$path"; then
      test $((0\${facts#* } & 022)) -eq 0 || return 1
    fi
    test "$path" = / && return 0
    path=$(dirname -- "$path")
  done
}

# succeeds when the path, as written and as resolved, is a regular file only
# root controls
trusted() {
  root_controlled "$1" || return 1
  target=$(readlink -f -- "$1") || return 1
  test -f "$target" && root_controlled "$target"
}

# passes a stop request on to the supervisor and exits once it has
finish() {
  if test -n "$pause"; then
    kill -TERM "$pause" 2>/dev/null
  fi
  if test -n "$child"; then
    kill -TERM "$child" 2>/dev/null
    wait "$child"
  fi
  exit 0
}
trap finish INT TERM

while :; do
  if trusted "$node" && trusted "$main"; then
    "$node" "$main" &
    child=$!
    wait "$child"
    code=$?
    child=
    note "supervisor=exited code=$code restart_in_s=${String(RESTART_SECONDS)}"
  else
    note "supervisor=refused reason=untrusted node=$node main=$main"
  fi
  sleep ${String(RESTART_SECONDS)} &
  pause=$!
  wait "$pause"
  pause=
done
`;

/**
 * renders the command entry: it runs the supervisor under the managed Node
 * once both, every directory above them and every link between are root's
 * alone, starts it again a few seconds after it exits, and passes a stop
 * request on to it, so the init never runs a file another account could
 * replace and never exits while the machine should run
 * @param params the Node executable, the main module and the log
 * @returns the POSIX shell script
 */
export function supervisorEntryScript(
  params: SupervisorEntryParams = {
    node: SUPERVISOR_NODE,
    main: SUPERVISOR_MAIN,
    log: SUPERVISOR_LOG,
  },
): string {
  return `${ENTRY_HEADER}node=${quote(params.node)}
main=${quote(params.main)}
log=${quote(params.log)}
${ENTRY_BODY}`;
}

/**
 * quotes a value for a POSIX shell assignment
 * @param value the raw value
 * @returns the value in single quotes
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", QUOTE_ESCAPE)}'`;
}
