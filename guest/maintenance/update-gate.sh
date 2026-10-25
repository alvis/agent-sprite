#!/bin/sh
# open-agent's update gate, root's alone: cron starts it every hour, and it
# runs the updater only once an update is due, which is when the last
# successful update, or the setup when none succeeded yet, lies the due
# interval environment.json records (one day when it records no usable one)
# behind; a baseline that cannot be read or lies ahead never holds an update
# back. An update and a setup session never overlap: the hourly gate takes
# the setup session's lock without waiting, and skips the hour, noting it in
# update.log, while a session holds it, and the workstation is kept awake
# while the update runs by a managed hold keyed by the gate's own process. The updater runs in a shell of its own, with the family's library
# and update fragment, the tool helpers, the link helpers and the version
# record sourced first,
# once every one is root's alone; it records the run in update-status.json,
# and the run's output goes to update.log. It exits 0 when no update was due
# or the run was recorded, whatever each tool's outcome, and 1 otherwise.
# `--force`, which setup passes from its session when the user asks for an
# update, runs the updater whether or not one is due, under the lock that
# session already holds

set -u
umask 022
PATH=$OA_SYSTEM_PATH
LC_ALL=C
export PATH LC_ALL

# what the gate reads, writes and runs in the guest root: the records come
# from the header, and every program sits at its path in the guest tree
OA_GATE_AWAKE=$OA_GUEST_ROOT/governor/awake.sh
OA_GATE_UPDATER=$OA_GUEST_ROOT/maintenance/updater.sh
OA_GATE_TOOLS=$OA_GUEST_ROOT/tools
# the system's jq, which root reads JSON with, never a tool link
OA_GATE_JQ=/usr/bin/jq
# the due interval's default and limit, in days: updateDueIntervalDays in
# src/core/profile.ts and MAX_UPDATE_DUE_DAYS in src/core/profile-rules.ts
OA_GATE_DEFAULT_DAYS=1
OA_GATE_MAX_DAYS=365
# the source and session the awake hold is recorded under
OA_GATE_HOLD=update

# tells whether a directory is root's alone: a real directory root owns that
# no group or other account can write
# arguments: the directory
oa_gate_root_only() {
  test -d "$1" && ! test -L "$1" &&
    test "$(stat -c %u "$1")" = 0 &&
    test $((0$(stat -c %a "$1") & 022)) -eq 0
}

# tells whether root may run a file: a regular file root's alone, as is every
# directory above it
# arguments: the file
oa_gate_trusted() {
  test -f "$1" && ! test -L "$1" || return 1
  test "$(stat -c %u "$1")" = 0 || return 1
  test $((0$(stat -c %a "$1") & 022)) -eq 0 || return 1
  oa_gate_directory=${1%/*}
  while test -n "$oa_gate_directory"; do
    oa_gate_root_only "$oa_gate_directory" || return 1
    oa_gate_directory=${oa_gate_directory%/*}
  done
  oa_gate_root_only /
}

# tells whether an update is due, and notes when the recorded due interval
# is not usable and the default applies
# arguments: the last success recorded, empty when none is
oa_gate_due() {
  oa_gate_due_verdict=$("$oa_gate_jq" -r --arg last "$1" \
    --argjson fallback "$OA_GATE_DEFAULT_DAYS" --argjson limit "$OA_GATE_MAX_DAYS" \
    -f /dev/stdin "$OA_ENVIRONMENT_PATH" <<'EOF'
def epoch: try (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) catch null;
(.schedule.dueDays) as $days
| (($days | type) == "number" and $days >= 1 and $days <= $limit and $days == ($days | floor)) as $usable
| (if $usable then $days else $fallback end) as $due
| (if $last != "" then $last else (.openAgent.setupAt // "") end | if type == "string" then epoch else null end) as $since
| [
    (if $since == null or $since > now or now - $since >= $due * 86400 then "due" else "wait" end),
    (if $usable then "" else "environment.json records no due interval from 1 to \($limit) days; using \($fallback)" end)
  ]
| @tsv
EOF
  ) || return 2
  oa_gate_due_note=${oa_gate_due_verdict#*"$(printf '\t')"}
  test -z "$oa_gate_due_note" || echo "update gate: $oa_gate_due_note" >&2
  test "${oa_gate_due_verdict%%"$(printf '\t')"*}" = due
}

# runs the updater in a shell of its own once the family's library and update
# fragment, the tool helpers, the link helpers, the version record and the
# updater are all root's alone
# arguments: the OS family
oa_gate_update() {
  set -- "$OA_GUEST_ROOT/os/$1/lib.sh" "$OA_GUEST_ROOT/os/$1/update-system.sh" \
    "$OA_GATE_TOOLS/homebrew/lib.sh" "$OA_GATE_TOOLS/npm/lib.sh" \
    "$OA_GATE_TOOLS/rustup/lib.sh" "$OA_GATE_TOOLS/links.sh" "$OA_GATE_TOOLS/versions.sh" \
    "$OA_GATE_UPDATER"
  for oa_gate_library; do
    if ! oa_gate_trusted "$oa_gate_library"; then
      echo "Refusing $oa_gate_library: it is missing or not root's alone"
      return 1
    fi
  done
  /bin/sh -c '. "$1" && . "$2" && . "$3" && . "$4" && . "$5" && . "$6" && . "$7" && . "$8" &&
    shift 8 && oa_update_run "$@"' oa-updater "$@" \
    "$OA_ENVIRONMENT_PATH" "$OA_UPDATE_STATUS_PATH" "$oa_gate_jq" "$OA_GATE_AWAKE" "$$"
}

case $# in
0) oa_gate_force=0 ;;
1)
  test "$1" = --force || {
    echo 'usage: update-gate.sh [--force]' >&2
    exit 2
  }
  oa_gate_force=1
  ;;
*)
  echo 'usage: update-gate.sh [--force]' >&2
  exit 2
  ;;
esac

if test "$(id -u)" != 0; then
  echo 'update-gate.sh is root'"'"'s alone' >&2
  exit 77
fi
test -f "$OA_ENVIRONMENT_PATH" || exit 0

oa_gate_jq=$OA_GATE_JQ
test -x "$oa_gate_jq" || {
  echo "update gate: no $OA_GATE_JQ reads $OA_ENVIRONMENT_PATH" >&2
  exit 1
}

# an hourly run takes the setup session's lock, in the directory the session
# makes root's alone, without waiting; a forced run comes from the session
# that holds it
if test "$oa_gate_force" != 1; then
  test -e "$OA_SESSION_DIRECTORY" || mkdir -m 0700 "$OA_SESSION_DIRECTORY" 2>/dev/null
  if ! oa_gate_root_only "$OA_SESSION_DIRECTORY" ||
    test "$(stat -c %a "$OA_SESSION_DIRECTORY")" != 700; then
    echo "update gate: $OA_SESSION_DIRECTORY is not a directory root's alone" >&2
    exit 1
  fi
  exec 9>>"$OA_SESSION_LOCK" || exit 1
  oa_gate_busy=
  flock -n 9 || oa_gate_busy=1
fi

oa_gate_last=$("$oa_gate_jq" -r '.lastSuccess | strings' "$OA_UPDATE_STATUS_PATH" 2>/dev/null) ||
  oa_gate_last=
if test "$oa_gate_force" != 1; then
  oa_gate_due "$oa_gate_last"
  case $? in
  0) ;;
  1) exit 0 ;;
  *)
    echo "update gate: $OA_ENVIRONMENT_PATH cannot be read" >&2
    exit 1
    ;;
  esac
  # a due update a setup session holds back waits for the next hour; the note
  # follows the last run's output, which the next run replaces
  if test -n "$oa_gate_busy"; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) update gate: a setup session holds the guest; the due update waits for the next hour" \
      >>"$OA_UPDATE_LOG"
    chmod 0600 "$OA_UPDATE_LOG"
    exit 0
  fi
fi

oa_gate_family=$("$oa_gate_jq" -r '.os.family | strings' "$OA_ENVIRONMENT_PATH") || oa_gate_family=
case $oa_gate_family in
'' | *[!a-z0-9]*)
  echo "update gate: $OA_ENVIRONMENT_PATH records no OS family" >&2
  exit 1
  ;;
esac

# the run's output replaces the last one's, so the log holds one run
exec >"$OA_UPDATE_LOG" 2>&1 || exit 1
chmod 0600 "$OA_UPDATE_LOG"
"$OA_GATE_AWAKE" hold-open --source "$OA_GATE_HOLD" --session "$OA_GATE_HOLD" --pid "$$"
oa_gate_update "$oa_gate_family"
oa_gate_status=$?
"$OA_GATE_AWAKE" hold-close --source "$OA_GATE_HOLD" --session "$OA_GATE_HOLD" --pid "$$"
test "$oa_gate_status" = 0 || exit 1
