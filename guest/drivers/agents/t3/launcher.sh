#!/bin/sh
# T3 Code's launcher, run as the agent by the t3-code service: it starts the
# agent's t3 on the port environment.json records, with the environment the
# agent keeps for its runtime, every selected harness's spawn environment and
# the committer the agent configured, then replaces itself with t3. Every
# output of t3 is discarded: it can mint startup credentials even with the
# browser disabled, so no token, pairing URL or QR reaches the service log

set -u

# reports why the launcher stopped and exits non-zero
# arguments: the reason
oa_fail() {
  echo "t3 launcher: $1" >&2
  exit 1
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
# runit runs one t3 for this base directory, so a server record found now is
# one a stop left behind; its process id may name another process after a
# boot, and t3 would refuse to start beside it
rm -f "$OA_T3_SERVER_RECORD" || oa_fail "$OA_T3_SERVER_RECORD cannot be removed"
exec "$OA_AGENT_BIN/t3" start --host 0.0.0.0 --port "$oa_port" \
  --base-dir "$OA_T3_HOME" --no-browser --log-level warn </dev/null >/dev/null 2>&1
