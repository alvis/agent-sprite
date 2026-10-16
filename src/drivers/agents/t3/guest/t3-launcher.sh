#!/bin/sh
# T3 Code's launcher, run as the agent by the t3-code service: it starts the
# agent's t3 on the port environment.json records, with the environment the
# agent keeps for its runtime, every selected harness's spawn environment and
# the committer the agent configured, then replaces itself with t3. Every
# output of t3 is discarded: it can mint startup credentials even with the
# browser disabled, so no token, pairing URL or QR reaches the service log

set -u

OA_HOME=/home/agent
OA_ENVIRONMENT=/opt/open-agent/environment.json
OA_RUNTIME=$OA_HOME/.config/open-agent/runtime-env.json
OA_COMMITTER=$OA_HOME/.config/open-agent/committer.json

# reports why the launcher stopped and exits non-zero
# arguments: the reason
oa_fail() {
  echo "t3 launcher: $1" >&2
  exit 1
}

# prints the export commands of a map of variable names to strings; refuses
# any other shape, so no name or value is ever read as shell code
# arguments: what the map is, for the error; the map arrives on stdin
oa_exports() {
  jq -nr 'input | if type == "object" and all(to_entries[];
        (.key | test("^[A-Z_a-z][0-9A-Z_a-z]*$")) and (.value | type == "string"))
      then to_entries[] | "export \(.key)=\(.value | @sh)"
      else error("malformed") end' 2>/dev/null ||
    oa_fail "$1 is malformed"
}

test -r "$OA_ENVIRONMENT" || oa_fail "$OA_ENVIRONMENT is not readable"
oa_port=$(jq -er '.agent.port | select(type == "number" and . >= 1 and . <= 65535 and floor == .)' \
  "$OA_ENVIRONMENT") || oa_fail "environment.json records no agent port"

# the agent's runtime environment first, so neither HOME nor a harness's
# environment can be overridden by it
if test -e "$OA_RUNTIME"; then
  oa_runtime=$(oa_exports "the agent's runtime environment" <"$OA_RUNTIME") || exit 1
  eval "$oa_runtime"
fi
HOME=$OA_HOME
export HOME
oa_harnesses=$(jq -c '[.agent.harnesses[]?.environment] | add // {}' "$OA_ENVIRONMENT" |
  oa_exports 'the harness environment') || exit 1
eval "$oa_harnesses"
# the agent's PATH: its own commands, then Homebrew's ahead of the system's
PATH=$OA_HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/bin:/usr/bin:/bin
export PATH
if test -e "$OA_COMMITTER"; then
  oa_committer=$(jq -c 'if type == "object" then
        {GIT_COMMITTER_NAME: .name, GIT_COMMITTER_EMAIL: .email}
          | with_entries(select(.value | type == "string"))
      else error("malformed") end' "$OA_COMMITTER" 2>/dev/null |
    oa_exports "the agent's committer") || exit 1
  eval "$oa_committer"
fi

cd "$OA_HOME" || oa_fail "$OA_HOME is missing"
exec "$OA_HOME/.local/bin/t3" start --host 0.0.0.0 --port "$oa_port" \
  --base-dir "$OA_HOME/.t3" --no-browser --log-level warn </dev/null >/dev/null 2>&1
