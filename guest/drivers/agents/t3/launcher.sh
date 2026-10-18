#!/bin/sh
# T3 Code's launcher, run as the agent by the t3-code service: it starts the
# agent's t3 on the port environment.json records, with the environment the
# agent keeps for its runtime, every selected harness's spawn environment and
# the committer the agent configured, then replaces itself with t3. T3 can mint
# startup credentials on stdout even with the browser disabled, so its output
# is never kept or logged whole: when the service backend made a directory on
# memory-backed storage for it, both streams go to a private pipe whose reader
# appends only T3's error headers, at most eight, to a private file there, never
# to the volume, and the backend's finish hook forwards the redacted headers of
# that file; without that directory, both streams are discarded

set -u

# where t3's stderr, and the reason the launcher stops, are captured: a fresh,
# owner-only file for this run, or nothing when the backend made no directory
# for it
oa_stderr=/dev/null
if (umask 077 && : >"$OA_T3_STDERR_CAPTURE") 2>/dev/null; then
  oa_stderr=$OA_T3_STDERR_CAPTURE
fi

# reports why the launcher stopped and exits non-zero, in the service log and
# in the capture, which the finish hook forwards to the machine's log
# arguments: the reason
oa_fail() {
  echo "t3 launcher: $1" >&2
  echo "t3 launcher: $1" >>"$oa_stderr" 2>/dev/null
  exit 1
}

# keeps the error headers of t3's output, at most eight and cut short, and
# nothing else, so the credentials and pairing URLs t3 prints never leave the
# pipe; it reads all of its input, so t3 is never blocked on a full pipe
# arguments: none; t3's output arrives on stdin and the headers leave on stdout
oa_t3_errors() {
  LC_ALL=C sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' |
    LC_ALL=C tr -cd ' -~\n' |
    LC_ALL=C awk 'n < 8 && /^( *\[cause\]: [A-Za-z0-9_]*Error: |ERROR \(#[0-9]+\): [A-Za-z0-9_]*Error: )/ {
      print substr($0, 1, 512)
      fflush()
      n++
    }'
}

# joins t3's stdout and stderr to one pipe whose reader is oa_t3_errors, which
# appends to the capture, so the launcher can exec t3 with both streams on
# file descriptor 5. The pipe is a private, unlinked FIFO of the capture's
# directory held open at both ends before it is unlinked, and the reader ends
# when t3, the last writer, exits. Fails, changing nothing, when there is no
# capture or the pipe cannot be made, and the caller discards stdout instead
oa_t3_pipe() {
  test "$oa_stderr" != /dev/null || return 1
  oa_pipe=$oa_stderr.pipe
  rm -f "$oa_pipe" && (umask 077 && mkfifo "$oa_pipe") 2>/dev/null || return 1
  if ! (exec 5<>"$oa_pipe") 2>/dev/null; then
    rm -f "$oa_pipe"
    return 1
  fi
  exec 5<>"$oa_pipe"
  exec 6<"$oa_pipe"
  rm -f "$oa_pipe"
  { oa_t3_errors >>"$oa_stderr" 2>/dev/null; } <&6 5>&- 6>&- &
}

# prints the export commands of a map of variable names to strings; refuses
# any other shape, so no name or value is ever read as shell code, and any
# OA_* name, which would override the launcher's own layout
# arguments: what the map is, for the error; the map arrives on stdin
oa_exports() {
  jq -nr 'input | if type == "object" and all(to_entries[];
        (.key | test("^[A-Z_a-z][0-9A-Z_a-z]*$")) and (.key | startswith("OA_") | not) and
        (.value | type == "string"))
      then to_entries[] | "export \(.key)=\(.value | @sh)"
      else error("malformed") end' 2>/dev/null ||
    oa_fail "$1 is malformed or names an OA_* variable"
}

test -r "$OA_ENVIRONMENT_PATH" || oa_fail "$OA_ENVIRONMENT_PATH is not readable"
oa_port=$(jq -er '.agent.port | select(type == "number" and . >= 1 and . <= 65535 and floor == .)' \
  "$OA_ENVIRONMENT_PATH") || oa_fail "environment.json records no agent port"

# the agent's runtime environment first, so neither HOME nor a harness's
# environment can be overridden by it
if test -e "$OA_RUNTIME_ENV_PATH"; then
  oa_runtime=$(oa_exports "the agent's runtime environment" <"$OA_RUNTIME_ENV_PATH") || exit 1
  eval "$oa_runtime"
fi
HOME=$OA_AGENT_HOME
export HOME
oa_harnesses=$(jq -c '[.agent.harnesses[]?.environment] | add // {}' "$OA_ENVIRONMENT_PATH" |
  oa_exports 'the harness environment') || exit 1
eval "$oa_harnesses"
# the agent's PATH: its own commands, then Homebrew's ahead of the system's
PATH=$OA_AGENT_PATH
export PATH
if test -e "$OA_COMMITTER_PATH"; then
  oa_committer=$(jq -c 'if type == "object" then
        {GIT_COMMITTER_NAME: .name, GIT_COMMITTER_EMAIL: .email}
          | with_entries(select(.value | type == "string"))
      else error("malformed") end' "$OA_COMMITTER_PATH" 2>/dev/null |
    oa_exports "the agent's committer") || exit 1
  eval "$oa_committer"
fi

cd "$OA_AGENT_HOME" || oa_fail "$OA_AGENT_HOME is missing"
# the free space the agent itself can use (df's available column excludes the
# blocks the filesystem reserves for root), in whole megabytes; a volume the
# agent cannot write to makes t3 fail with an error nothing else logs
oa_free_mb=$(df -Pk "$OA_AGENT_HOME" 2>/dev/null |
  awk 'NR == 2 && $4 ~ /^[0-9]+$/ { print int($4 / 1024) }')
if test -n "$oa_free_mb" && test "$oa_free_mb" -lt "$OA_T3_MIN_FREE_MB"; then
  oa_fail "only $oa_free_mb MB free on $OA_AGENT_HOME; T3 needs at least $OA_T3_MIN_FREE_MB MB"
fi
# runit runs one t3 for this base directory, so a server record found now is
# one a stop left behind; its process id may name another process after a
# boot, and t3 would refuse to start beside it
rm -f "$OA_T3_SERVER_RECORD" || oa_fail "$OA_T3_SERVER_RECORD cannot be removed"
set -- start --host 0.0.0.0 --port "$oa_port" \
  --base-dir "$OA_T3_HOME" --no-browser --log-level warn
if oa_t3_pipe; then
  exec "$OA_AGENT_BIN/t3" "$@" </dev/null >&5 2>&5 5>&- 6>&-
fi
exec "$OA_AGENT_BIN/t3" "$@" </dev/null >/dev/null 2>>"$oa_stderr"
