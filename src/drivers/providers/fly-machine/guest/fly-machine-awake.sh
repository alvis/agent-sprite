#!/bin/sh
# open-agent's Fly Machine awake adapter, root's alone: the idle governor's
# tick runs `enter-idle-form` once the machine may sleep, and it prints one
# line, `entered <form>`, `unknown <why>` or `failure <why>`. It puts the
# machine into its first available idle form through the guest-local
# Machines API socket, which only root reaches and which needs no token: the
# machine suspends from memory when it can, and is stopped when it cannot or
# the suspend is refused. A suspend request that ends without an answer is
# not followed by a stop, since the machine may have been suspended and
# resumed already, and stopping it then would undo the resume. The machine
# names itself from the FLY_* variables the Fly init gives the guest; runit
# starts every service, cron among them, with an empty environment, so they
# come from the nearest ancestor process that still has them

set -u
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

# the guest-local Machines API socket and the host name it expects
OA_FLY_SOCKET=/.fly/api
OA_FLY_HOST=flaps
# largest memory a suspended machine may have, in megabytes
OA_FLY_SUSPEND_LIMIT_MB=2048
# most bytes kept of an answer for a failure, and of a machine description
OA_FLY_EXCERPT_BYTES=256
OA_FLY_MACHINE_BYTES=262144
# seconds an eligibility lookup, and a suspend or stop request, may take
OA_FLY_INSPECT_SECONDS=5
OA_FLY_ACTION_SECONDS=20
# most ancestors searched for the Fly variables
OA_FLY_ANCESTORS=64

# prints a Fly variable: this process's own when set, else the nearest
# ancestor's
# arguments: the variable's name
oa_fly_variable() {
  oa_fly_variable_value=$(printenv "$1") || oa_fly_variable_value=
  oa_fly_variable_pid=$$
  oa_fly_variable_hops=0
  while test -z "$oa_fly_variable_value" && test "$oa_fly_variable_pid" -gt 1 &&
    test "$oa_fly_variable_hops" -lt "$OA_FLY_ANCESTORS"; do
    oa_fly_variable_stat=$(cat "/proc/$oa_fly_variable_pid/stat" 2>/dev/null) || return 1
    # the command name can hold any character, so the parent is counted
    # from its closing parenthesis: the state first, the parent second
    oa_fly_variable_pid=$(printf '%s\n' "${oa_fly_variable_stat##*) }" | cut -d ' ' -f 2)
    case $oa_fly_variable_pid in '' | *[!0-9]*) return 1 ;; esac
    oa_fly_variable_value=$(tr '\000' '\n' <"/proc/$oa_fly_variable_pid/environ" 2>/dev/null |
      sed -n "s/^$1=//p" | head -n 1)
    oa_fly_variable_hops=$((oa_fly_variable_hops + 1))
  done
  test -n "$oa_fly_variable_value" && printf '%s\n' "$oa_fly_variable_value"
}

# sends one request to the Machines API about this machine, keeping the
# answer's body in the work directory, and prints the status, 000 when no
# answer came; the reason of a request that failed is kept as well
# arguments: the method, the path below the machine, the seconds it may take
oa_fly_call() {
  set -- "$1" "$2" "$3" "http://$OA_FLY_HOST/v1/apps/$oa_fly_app/machines/$oa_fly_machine$2"
  if test "$1" = GET; then
    curl -sS --unix-socket "$OA_FLY_SOCKET" --max-time "$3" --max-filesize "$OA_FLY_MACHINE_BYTES" \
      -o "$oa_fly_work/body" -w '%{http_code}' "$4" 2>"$oa_fly_work/error"
  else
    curl -sS --unix-socket "$OA_FLY_SOCKET" --max-time "$3" -X "$1" -H 'Content-Length: 0' \
      -o "$oa_fly_work/body" -w '%{http_code}' "$4" 2>"$oa_fly_work/error"
  fi
}

# prints the start of the last answer's body as one line
oa_fly_excerpt() {
  head -c "$OA_FLY_EXCERPT_BYTES" "$oa_fly_work/body" 2>/dev/null | tr '[:cntrl:]' ' '
}

# prints the reason the last request failed as one line
oa_fly_error() {
  oa_fly_error_text=$(head -c "$OA_FLY_EXCERPT_BYTES" "$oa_fly_work/error" 2>/dev/null | tr '[:cntrl:]' ' ')
  printf '%s\n' "${oa_fly_error_text:-the Machines API closed without an answer}"
}

# prints why the machine may not suspend: more than 2 GB of memory, swap or
# a schedule; the memory is known from the environment, and the description
# the API gives back, when it can be read, rules out swap and a schedule as
# well. A description that cannot be read rules nothing out, since the
# suspend request is then refused by the API itself
oa_fly_suspend_blocker() {
  oa_fly_suspend_blocker_memory=$(oa_fly_variable FLY_VM_MEMORY_MB) || oa_fly_suspend_blocker_memory=
  case $oa_fly_suspend_blocker_memory in
  '' | *[!0-9]* | ?????????*) ;;
  *)
    if test "$oa_fly_suspend_blocker_memory" -gt "$OA_FLY_SUSPEND_LIMIT_MB"; then
      echo "the machine has $oa_fly_suspend_blocker_memory MB of memory, more than the $OA_FLY_SUSPEND_LIMIT_MB MB a suspended machine may have"
      return
    fi
    ;;
  esac
  case $(oa_fly_call GET '' "$OA_FLY_INSPECT_SECONDS") in 2??) ;; *) return ;; esac
  /usr/bin/jq -r --argjson limit "$OA_FLY_SUSPEND_LIMIT_MB" '
    try (.config | select(type == "object")
      | if (.guest | type) == "object" and (.guest.memory_mb | type) == "number" and .guest.memory_mb > $limit then
          "the machine has \(.guest.memory_mb) MB of memory, more than the \($limit) MB a suspended machine may have"
        elif (.swap_size_mb | type) == "number" and .swap_size_mb > 0 then
          "the machine has swap configured, which a suspended machine cannot have"
        elif (.schedule | type) == "string" and .schedule != "" then
          "the machine has a schedule configured, which a suspended machine cannot have"
        else empty end) catch empty' "$oa_fly_work/body" 2>/dev/null | head -n 1
}

# stops the machine when a suspend was refused or is not possible
# arguments: why the machine did not suspend
oa_fly_stop_instead() {
  oa_fly_stop_instead_status=$(oa_fly_call POST /stop "$OA_FLY_ACTION_SECONDS")
  case $oa_fly_stop_instead_status in
  2??) echo 'entered stop' ;;
  000) echo "failure the machine is still running: $1; the stop request failed: $(oa_fly_error)" ;;
  *) echo "failure the machine is still running: $1; stop answered $oa_fly_stop_instead_status: $(oa_fly_excerpt)" ;;
  esac
}

# suspends the machine from memory, or stops it when it is not suspend
# eligible or the suspend is refused
oa_fly_enter_idle_form() {
  oa_fly_app=$(oa_fly_variable FLY_APP_NAME) || oa_fly_app=
  oa_fly_machine=$(oa_fly_variable FLY_MACHINE_ID) || oa_fly_machine=
  case $oa_fly_app in '' | [!a-z0-9]* | *[!a-z0-9-]*) oa_fly_app= ;; esac
  case $oa_fly_machine in '' | *[!a-z0-9]*) oa_fly_machine= ;; esac
  if test -z "$oa_fly_app" || test "${#oa_fly_app}" -gt 63 ||
    test -z "$oa_fly_machine" || test "${#oa_fly_machine}" -gt 32; then
    echo 'failure FLY_APP_NAME and FLY_MACHINE_ID are not set to a Fly app and machine, so the machine cannot name itself'
    return
  fi
  oa_fly_enter_idle_form_blocker=$(oa_fly_suspend_blocker)
  if test -n "$oa_fly_enter_idle_form_blocker"; then
    oa_fly_stop_instead "$oa_fly_enter_idle_form_blocker"
    return
  fi
  oa_fly_enter_idle_form_status=$(oa_fly_call POST /suspend "$OA_FLY_ACTION_SECONDS")
  case $oa_fly_enter_idle_form_status in
  2??) echo 'entered memory-suspend' ;;
  # a snapshot taken mid-request can reset the connection on resume, so no
  # answer does not mean the suspend failed
  000) echo "unknown the suspend request ended without an answer, so the machine may have been suspended and resumed: $(oa_fly_error)" ;;
  *) oa_fly_stop_instead "suspend answered $oa_fly_enter_idle_form_status: $(oa_fly_excerpt)" ;;
  esac
}

case ${1-} in
enter-idle-form)
  oa_fly_work=$(mktemp -d) || {
    echo 'failure the adapter could not make a work directory'
    exit 0
  }
  trap 'rm -rf "$oa_fly_work"' EXIT
  trap 'exit 143' HUP INT TERM
  oa_fly_enter_idle_form
  ;;
*)
  echo 'usage: fly-machine-awake.sh enter-idle-form; a Fly Machine applies no deadline' >&2
  exit 64
  ;;
esac
