# open-agent's runit service backend: each service environment.json records
# is a root-owned service directory under /etc/sv, enabled by its link in the
# directory runsvdir supervises, and each drops to its own account through
# chpst. Each also has a finish hook, which writes one line to the machine's
# log whenever the service exits, and a service that serves HTTP has a
# readiness check, which writes one line once it answers or after a bounded
# wait. Setup and the boot hook source it as root; it needs sv, chpst and
# svlogd on PATH and reads JSON with the system's jq, /usr/bin/jq. Every function is safe to rerun, reports why it failed
# on stderr and returns non-zero, and keeps its variables under its own oa_
# prefix since sh has no locals

# where service definitions live, and the directory runsvdir supervises
OA_SV_DEFINITIONS=/etc/sv
OA_SV_SERVICES=/etc/service
# where each service's log goes, one directory a service
OA_SV_LOGS=/var/log/open-agent
# the file that marks a service directory as open-agent's and records its definition
OA_SV_MARK=open-agent.json
# seconds sv waits for a service to start or stop, and setup waits for
# runsvdir to notice a new service, which it looks for every 5 seconds
OA_SV_WAIT=30
# the PATH every run file, and every root service, starts with: the system's
# commands ahead of the tool links in /usr/local, so no link shadows one root
# runs. Root runs runit's and tailscaled's Homebrew binaries only because the
# Homebrew account is locked and root alone writes it, acting as it
OA_SV_PATH=$OA_SESSION_PATH
# the PATH an agent service starts with after its own commands: the account
# PATH, Homebrew's commands ahead of the tool links and the system's
OA_SV_AGENT_PATH=$OA_ACCOUNT_PATH
# where each service keeps its runtime state on memory-backed storage: the
# root-owned marker of when it started, and a private directory of its
# account, where the service may capture its own stderr for its finish hook
OA_SV_STATE=$OA_SERVICE_STATE_DIRECTORY
# seconds the readiness check of a service waits for it to answer
OA_SV_READY_WAIT=120
# a service name, which names its directory, its link and its log
OA_SV_NAME='^[a-z0-9][a-z0-9._-]*$'
# whether the last oa_sv_write found something to change, and whether it only
# looks: set oa_sv_dry to check what a write would change without writing it
oa_sv_changed=
oa_sv_dry=

# refuses a name that is not a service name
# arguments: the name
oa_sv_name() {
  case $1 in
    '' | [!a-z0-9]* | *[!a-z0-9._-]*)
      echo "Refusing the service name $1" >&2
      return 1
      ;;
  esac
}

# writes a file unless it already holds the contents, root-owned with a mode;
# a dry run only notes that it would
# arguments: path, mode, contents
oa_sv_file() {
  if test -f "$1" && ! test -L "$1" && test "$(cat "$1")" = "$3" &&
    test "$(stat -c '%u %a' "$1")" = "0 ${2#0}"; then
    return 0
  fi
  oa_sv_changed=1
  if test -n "$oa_sv_dry"; then
    return 0
  fi
  printf '%s\n' "$3" >"$1.new" && chmod "$2" "$1.new" && mv -f "$1.new" "$1"
}

# makes a root-owned directory with a mode unless it exists; a dry run only
# notes that it would
# arguments: mode, path
oa_sv_directory() {
  if test -d "$2" && ! test -L "$2"; then
    return 0
  fi
  oa_sv_changed=1
  if test -z "$oa_sv_dry"; then
    install -d -m "$1" "$2"
  fi
}

# tells whether runsv supervises a service
# arguments: service name
oa_sv_supervised() {
  sv status "$OA_SV_DEFINITIONS/$1" >/dev/null 2>&1
}

# tells whether a definition is well formed, before any of it reaches a file
# arguments: the definition, as JSON
oa_sv_valid() {
  printf '%s' "$1" | /usr/bin/jq -e --arg name "$OA_SV_NAME" '
    (.name | type == "string" and test($name)) and
    (.account == "root" or .account == "agent") and
    (.command | type == "string" and startswith("/")) and
    (.arguments | type == "array" and all(.[]; type == "string")) and
    (.needs | type == "array" and all(.[]; type == "string" and test($name))) and
    (.httpPort == null or (.httpPort | type == "number" and floor == . and . >= 1 and . <= 65535)) and
    (.machineLog == null or (.machineLog | type == "boolean"))' \
    >/dev/null
}

# renders a definition as its run file: note when the service started and
# make its private runtime state, wait for every service it needs, then replace
# the shell with the command, as its account, from its home, with a clean
# environment and its account's PATH; a service with an HTTP port also starts
# its readiness check, which writes to the machine's log, saved as the run
# file's descriptor 3 and closed for the service; a service that records the
# machine's log itself, such as the awake events' relay, has it as its stderr.
# Every word is quoted, so none is read as shell code. Nothing about the runtime state may stop the service
# from starting
# arguments: the definition, as JSON, and its account's home
oa_sv_run() {
  printf '%s' "$1" | /usr/bin/jq -r --arg path "$OA_SV_PATH" --arg agentPath "$OA_SV_AGENT_PATH" \
    --arg wait "$OA_SV_WAIT" --arg services "$OA_SV_SERVICES" --arg home "$2" \
    --arg state "$OA_SV_STATE" --arg definitions "$OA_SV_DEFINITIONS" '
    "#!/bin/sh",
    "# open-agent service \(.name), written from its definition in environment.json",
    "exec 3>&2",
    "exec 2>&1",
    "PATH=\($path | @sh)",
    "export PATH",
    "install -d -m 0755 \($state | @sh) && install -d -m 0700 -o \(.account | @sh) \("\($state)/\(.name)" | @sh) || true",
    "rm -f \("\($state)/\(.name)/stderr" | @sh)",
    "awk \u0027{ printf \"%d\\n\", $1 * 1000 }\u0027 /proc/uptime >\("\($state)/\(.name).started" | @sh) || true",
    (.needs[] | "sv -w \($wait) start \("\($services)/\(.)" | @sh) >/dev/null || exit 1"),
    "cd \($home | @sh) || exit 1",
    (if .httpPort == null then empty else "/bin/sh \("\($definitions)/\(.name)/ready" | @sh) \(.name | @sh) \(.httpPort) </dev/null >/dev/null 2>&3 3>&- &" end),
    "exec \(if .account == "root" then "" else "chpst -u \(.account | @sh) " end)env -i HOME=\($home | @sh) USER=\(.account | @sh) LOGNAME=\(.account | @sh) PATH=\(if .account == "root" then $path else "\($home)/.local/bin:\($agentPath)" end | @sh) LANG=C.UTF-8 \([.command] + .arguments | map(@sh) | join(" ")) \(if .machineLog == true then "2>&3 " else "" end)3>&-"'
}

# renders the finish hook of every service. runsv runs it each time the
# service exits, with the exit code and the wait status, and its stderr is the
# machine's log, so it writes one line there: the service, its exit code, how
# long it ran and, when the service captured its stderr, the redacted error
# headers of it. Only lines of a known error shape are read, each is reduced
# to printable ASCII, has URLs, query strings, e-mail addresses, credentials,
# JWTs and long tokens replaced and is cut short, so no secret is written. The
# hook never fails, and it clears the start marker and the capture it read. The
# capture sits in a directory the service's account owns and the hook runs as
# root, so it is opened once, without following a link and without blocking,
# under a two second limit, and a read that fails gives no reason: a link
# swapped in after a check would be followed and a pipe would hold the hook,
# and with it the service's restart, for good
oa_sv_finish() {
  printf '#!/bin/sh\n'
  printf '# open-agent service finish hook, written by oa_sv_finish\n'
  printf 'oa_state=%s\n' "$OA_SV_STATE"
  cat <<'EOF'
oa_name=$(pwd -P)
oa_name=${oa_name##*/}
oa_code=${1:-unknown}
oa_runtime=unknown
oa_started=$(cat "$oa_state/$oa_name.started" 2>/dev/null)
oa_now=$(awk '{ printf "%d", $1 * 1000 }' /proc/uptime 2>/dev/null)
case $oa_started in
  '' | *[!0-9]*) ;;
  *)
    case $oa_now in
      '' | *[!0-9]*) ;;
      *) oa_runtime=$((oa_now - oa_started)) ;;
    esac
    ;;
esac
oa_capture=$oa_state/$oa_name/stderr
oa_reason=
if test -e "$oa_capture" || test -L "$oa_capture"; then
  oa_reason=$(timeout 2 dd if="$oa_capture" iflag=nofollow,nonblock \
    bs=65537 count=1 status=none 2>/dev/null |
    LC_ALL=C sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' |
    LC_ALL=C tr -cd ' -~\n' |
    LC_ALL=C tr -d '"' |
    LC_ALL=C grep -E '^( *\[cause\]: [A-Za-z0-9_]*Error: |ERROR \(#[0-9]+\): [A-Za-z0-9_]*Error: |t3 launcher: )' |
    head -n 4 |
    LC_ALL=C sed -E \
      -e 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]*#<url>#g' \
      -e 's#eyJ[A-Za-z0-9_.+/=-]*#<jwt>#g' \
      -e 's#[^[:space:]]*@[^[:space:]]*#<redacted>#g' \
      -e 's#(token|secret|password|passwd|credential|authorization|apikey|api[_-]key|cookie|pairing|bearer)[A-Za-z0-9_-]*[=:] *[^[:space:]]+#\1=<redacted>#Ig' \
      -e 's#bearer +[^[:space:]]+#bearer <redacted>#Ig' \
      -e 's#\?[^[:space:]]+#?<redacted>#g' |
    LC_ALL=C awk '{
      out = ""
      while (match($0, /[A-Za-z0-9_+=-]+/)) {
        word = substr($0, RSTART, RLENGTH)
        if (RLENGTH >= 20 && word ~ /[0-9]/) word = "<redacted>"
        out = out substr($0, 1, RSTART - 1) word
        $0 = substr($0, RSTART + RLENGTH)
      }
      print out $0
    }' |
    cut -c1-160 |
    paste -sd ';' -)
fi
if test -n "$oa_reason"; then
  oa_reason=" reason=\"$oa_reason\""
fi
printf 'open-agent-service %s service=%s exit=%s runtime_ms=%s%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$oa_name" "$oa_code" "$oa_runtime" "$oa_reason" >&2
rm -f "$oa_state/$oa_name.started" "$oa_capture"
exit 0
EOF
}

# renders the readiness check of a service that serves HTTP. The run file
# starts it in the background with the machine's log as its stderr; it polls
# the service's loopback port until the service answers with any HTTP status,
# then writes one line with the time since the service started, or after a
# bounded wait writes that the service is not ready. It stops silently when
# the service exits or restarts meanwhile, and nothing in it waits for the boot
# arguments: none; the service's name and port are its arguments when it runs
oa_sv_ready() {
  printf '#!/bin/sh\n'
  printf '# open-agent service readiness check, written by oa_sv_ready\n'
  printf 'oa_state=%s\n' "$OA_SV_STATE"
  printf 'oa_limit=%s\n' "$OA_SV_READY_WAIT"
  cat <<'EOF'
oa_name=$1
oa_port=$2
oa_started=$(cat "$oa_state/$oa_name.started" 2>/dev/null)
case $oa_started in
  '' | *[!0-9]*) exit 0 ;;
esac
while :; do
  oa_now=$(awk '{ printf "%d", $1 * 1000 }' /proc/uptime 2>/dev/null)
  case $oa_now in
    '' | *[!0-9]*) exit 0 ;;
  esac
  oa_status=$(/usr/bin/curl -s -o /dev/null --max-time 2 -w '%{http_code}' \
    "http://127.0.0.1:$oa_port/" 2>/dev/null)
  case $oa_status in
    '' | 000) ;;
    *)
      printf 'open-agent-service %s service=%s ready duration_ms=%s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$oa_name" "$((oa_now - oa_started))" >&2
      exit 0
      ;;
  esac
  if test "$((oa_now - oa_started))" -ge "$((oa_limit * 1000))"; then
    printf 'open-agent-service %s service=%s not-ready after %ss\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$oa_name" "$oa_limit" >&2
    exit 0
  fi
  sleep 0.5
  test "$(cat "$oa_state/$oa_name.started" 2>/dev/null)" = "$oa_started" || exit 0
done
EOF
}

# removes a file of a service's directory that its definition no longer has; a
# dry run only notes that it would
# arguments: path
oa_sv_unfile() {
  if ! test -e "$1" && ! test -L "$1"; then
    return 0
  fi
  oa_sv_changed=1
  if test -z "$oa_sv_dry"; then
    rm -f "$1"
  fi
}

# writes one service's directory, run file, finish hook, readiness check, log and enabling link from its
# definition; what already matches is left as it is, and oa_sv_changed tells
# whether the run file or anything else changed
# arguments: the definition, as JSON
oa_sv_write() {
  oa_sv_changed=
  if ! oa_sv_valid "$1"; then
    echo "Refusing a malformed service definition" >&2
    return 1
  fi
  oa_write_name=$(printf '%s' "$1" | /usr/bin/jq -r .name) || return 1
  oa_write_account=$(printf '%s' "$1" | /usr/bin/jq -r .account) || return 1
  oa_write_home=$(getent passwd "$oa_write_account" | cut -d: -f6)
  if test -z "$oa_write_home"; then
    echo "There is no account $oa_write_account to run $oa_write_name as" >&2
    return 1
  fi
  oa_write_run=$(oa_sv_run "$1" "$oa_write_home") || return 1
  oa_write_port=$(printf '%s' "$1" | /usr/bin/jq -r '.httpPort // empty') || return 1
  oa_write_definition=$(printf '%s' "$1" | /usr/bin/jq -c .) || return 1
  oa_write_directory=$OA_SV_DEFINITIONS/$oa_write_name
  oa_write_log=$OA_SV_LOGS/$oa_write_name
  oa_sv_directory 0755 "$OA_SV_DEFINITIONS" &&
    oa_sv_directory 0755 "$OA_SV_SERVICES" &&
    oa_sv_directory 0755 "$OA_SV_LOGS" &&
    oa_sv_directory 0755 "$oa_write_directory" &&
    oa_sv_directory 0755 "$oa_write_directory/log" &&
    oa_sv_directory 0700 "$oa_write_log" || return 1
  # the log keeps four rotated files of at most 512 KiB beside the current one
  oa_sv_file "$oa_write_log/config" 0644 "$(printf 's524288\nn4')" &&
    oa_sv_file "$oa_write_directory/log/run" 0755 \
      "$(printf '#!/bin/sh\nexec svlogd -tt %s' "$oa_write_log")" &&
    oa_sv_file "$oa_write_directory/$OA_SV_MARK" 0644 "$oa_write_definition" &&
    oa_sv_file "$oa_write_directory/finish" 0755 "$(oa_sv_finish)" &&
    oa_sv_file "$oa_write_directory/run" 0755 "$oa_write_run" || return 1
  if test -n "$oa_write_port"; then
    oa_sv_file "$oa_write_directory/ready" 0755 "$(oa_sv_ready)" || return 1
  else
    oa_sv_unfile "$oa_write_directory/ready" || return 1
  fi
  if test "$(readlink "$OA_SV_SERVICES/$oa_write_name")" = "$oa_write_directory"; then
    return 0
  fi
  oa_sv_changed=1
  if test -z "$oa_sv_dry"; then
    ln -sfn "$oa_write_directory" "$OA_SV_SERVICES/$oa_write_name"
  fi
}

# installs one service from its definition and restarts it when it is
# supervised and anything of it changed; it waits for nothing
# arguments: the definition, as JSON
oa_sv_put() {
  oa_sv_write "$1" || return 1
  oa_put_name=$(printf '%s' "$1" | /usr/bin/jq -r .name) || return 1
  if test -n "$oa_sv_changed" && oa_sv_supervised "$oa_put_name"; then
    sv -w "$OA_SV_WAIT" restart "$OA_SV_DEFINITIONS/$oa_put_name" >/dev/null
  fi
}

# waits for runsvdir to supervise a service, then starts it and waits for it
# to run
# arguments: service name
oa_sv_up() {
  oa_up_waited=0
  until oa_sv_supervised "$1"; do
    if test "$oa_up_waited" -ge "$OA_SV_WAIT"; then
      echo "runsvdir does not supervise $1; is it running on $OA_SV_SERVICES?" >&2
      return 1
    fi
    sleep 1
    oa_up_waited=$((oa_up_waited + 1))
  done
  sv -w "$OA_SV_WAIT" start "$OA_SV_DEFINITIONS/$1" >/dev/null
}

# lists the services environment.json records, refusing any name that is not
# a service name
# arguments: path of environment.json
oa_sv_names() {
  if ! /usr/bin/jq -e --arg name "$OA_SV_NAME" \
    '.services | type == "array" and all(.[]; .name | type == "string" and test($name))' \
    "$1" >/dev/null; then
    echo "Refusing $1: its services are malformed" >&2
    return 1
  fi
  /usr/bin/jq -r '.services[].name' "$1"
}

# prints one service's definition from environment.json
# arguments: path of environment.json, service name
oa_sv_definition() {
  /usr/bin/jq -c --arg service "$2" '.services[] | select(.name == $service)' "$1"
}

# lists open-agent's installed services, each marked by its recorded definition
oa_sv_installed() {
  for oa_installed_mark in "$OA_SV_DEFINITIONS"/*/"$OA_SV_MARK"; do
    test -f "$oa_installed_mark" || continue
    oa_installed_name=${oa_installed_mark%/*}
    printf '%s\n' "${oa_installed_name##*/}"
  done
}

# stops and removes one of open-agent's services; a service that is not
# installed is left alone, and one open-agent did not install is refused
# arguments: service name
oa_sv_remove() {
  oa_sv_name "$1" || return 1
  oa_remove_directory=$OA_SV_DEFINITIONS/$1
  if ! test -e "$oa_remove_directory"; then
    rm -f "$OA_SV_SERVICES/$1"
    return 0
  fi
  if ! test -f "$oa_remove_directory/$OA_SV_MARK"; then
    echo "Refusing to remove $1: open-agent did not install it" >&2
    return 1
  fi
  # unlinked first, so runsvdir never starts it again
  rm -f "$OA_SV_SERVICES/$1" || return 1
  if oa_sv_supervised "$1"; then
    sv -w "$OA_SV_WAIT" force-stop "$oa_remove_directory" >/dev/null
    sv exit "$oa_remove_directory" >/dev/null
    oa_remove_waited=0
    while oa_sv_supervised "$1"; do
      if test "$oa_remove_waited" -ge "$OA_SV_WAIT"; then
        echo "runsv of $1 did not exit" >&2
        return 1
      fi
      sleep 1
      oa_remove_waited=$((oa_remove_waited + 1))
    done
  fi
  rm -rf "$oa_remove_directory"
}

# installs every service environment.json records, restarting a supervised
# one whose definition changed, and removes open-agent's services it no
# longer records. It waits for nothing, so the boot hook runs it before it
# starts runsvdir
# arguments: path of environment.json
oa_sv_install() {
  oa_install_names=$(oa_sv_names "$1") || return 1
  for oa_install_name in $oa_install_names; do
    oa_install_definition=$(oa_sv_definition "$1" "$oa_install_name") || return 1
    oa_sv_put "$oa_install_definition" || return 1
  done
  for oa_install_name in $(oa_sv_installed); do
    if ! printf '%s\n' "$oa_install_names" | grep -qxF -- "$oa_install_name"; then
      oa_sv_remove "$oa_install_name" || return 1
    fi
  done
}

# starts every service environment.json records and waits for each to run
# arguments: path of environment.json
oa_sv_start() {
  oa_start_names=$(oa_sv_names "$1") || return 1
  for oa_start_name in $oa_start_names; do
    oa_sv_up "$oa_start_name" || return 1
  done
}

# tells whether every service environment.json records is installed as it is
# defined and running, and no other of open-agent's services is installed
# arguments: path of environment.json
oa_sv_check() {
  oa_check_names=$(oa_sv_names "$1") || return 1
  for oa_check_name in $oa_check_names; do
    oa_check_definition=$(oa_sv_definition "$1" "$oa_check_name") || return 1
    oa_sv_dry=1
    oa_sv_write "$oa_check_definition"
    oa_check_status=$?
    oa_sv_dry=
    if test "$oa_check_status" -ne 0 || test -n "$oa_sv_changed"; then
      return 1
    fi
    sv status "$OA_SV_DEFINITIONS/$oa_check_name" 2>/dev/null | grep -q '^run:' ||
      return 1
  done
  test "$(oa_sv_installed | sort)" = "$(printf '%s\n' "$oa_check_names" | sort)"
}

# installs one service from its definition and waits for it to run
# arguments: the definition, as JSON
oa_sv_ensure() {
  oa_sv_put "$1" || return 1
  oa_sv_up "$(printf '%s' "$1" | /usr/bin/jq -r .name)"
}

# stops one of open-agent's services and waits for it to stop; exits 2 when
# it is not installed, and 1 when it did not stop in time
# arguments: service name
oa_sv_stop() {
  oa_sv_name "$1" || return 2
  if ! test -f "$OA_SV_DEFINITIONS/$1/$OA_SV_MARK"; then
    echo "There is no open-agent service $1" >&2
    return 2
  fi
  if ! oa_sv_supervised "$1"; then
    return 0
  fi
  sv -w "$OA_SV_WAIT" stop "$OA_SV_DEFINITIONS/$1" >/dev/null
}

# prints the state of each of open-agent's services as one JSON line of
# {name, status, needs, startedAt}; a service runsv does not supervise is
# stopped
oa_sv_states() {
  oa_states_now=$(date +%s) || return 1
  for oa_states_name in $(oa_sv_installed); do
    oa_states_line=$(sv status "$OA_SV_DEFINITIONS/$oa_states_name" 2>/dev/null) ||
      oa_states_line=
    oa_states_started=
    case $oa_states_line in
      run:*)
        oa_states_status=running
        # `run: /etc/sv/name: (pid 123) 45s; run: log: ...`
        oa_states_seconds=$(printf '%s' "$oa_states_line" |
          sed -n 's/^run:[^)]*) \([0-9][0-9]*\)s.*/\1/p')
        if test -n "$oa_states_seconds"; then
          oa_states_started=$(date -u -d "@$((oa_states_now - oa_states_seconds))" \
            +%Y-%m-%dT%H:%M:%SZ) || return 1
        fi
        ;;
      down:*'want up'*) oa_states_status=starting ;;
      finish:*) oa_states_status=stopping ;;
      *) oa_states_status=stopped ;;
    esac
    /usr/bin/jq -c --arg status "$oa_states_status" --arg started "$oa_states_started" \
      '{name, status: $status, needs} + (if $started == "" then {} else {startedAt: $started} end)' \
      "$OA_SV_DEFINITIONS/$oa_states_name/$OA_SV_MARK" || return 1
  done
}

# prints the state of every one of open-agent's services as one JSON array
oa_sv_list() {
  oa_list_states=$(oa_sv_states) || return 1
  printf '%s\n' "$oa_list_states" | /usr/bin/jq -s -c .
}
