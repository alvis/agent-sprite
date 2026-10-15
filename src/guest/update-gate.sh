#!/bin/sh
# open-agent's update gate, root's alone: cron starts it every hour, and it
# runs the updater only once an update is due, which is when the last
# successful update, or the setup when none succeeded yet, lies the due
# interval environment.json records (one day when it records no usable one)
# behind; a baseline that cannot be read or lies ahead never holds an update
# back. One update runs at a time, under the update lock, and the workstation
# is kept awake while it runs by a managed hold keyed by the gate's own
# process. The updater runs in a shell of its own, with the family's library
# and update fragment, the tool helpers and the link helpers sourced first,
# once every one is root's alone; it records the run in update-status.json,
# and the run's output goes to update.log. It exits 0 when no update was due
# or the run was recorded, whatever each tool's outcome, and 1 otherwise

set -u
umask 022
PATH=/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

# the guest root and what the gate reads and writes there: GUEST_ROOT in
# src/guest/guest-root.ts, the lock in src/guest/update-schedule.ts and the
# assets in src/integrations/guest/updates.ts, which this shell cannot import
OA_GATE_ROOT=/opt/open-agent
OA_GATE_ENVIRONMENT=$OA_GATE_ROOT/environment.json
OA_GATE_STATUS=$OA_GATE_ROOT/update-status.json
OA_GATE_LOG=$OA_GATE_ROOT/update.log
OA_GATE_LOCK_DIRECTORY=$OA_GATE_ROOT/lock
OA_GATE_LOCK=$OA_GATE_LOCK_DIRECTORY/update.lock
OA_GATE_AWAKE=$OA_GATE_ROOT/guest/awake.sh
OA_GATE_UPDATER=$OA_GATE_ROOT/guest/updater.sh
OA_GATE_TOOLS=$OA_GATE_ROOT/tools
# Homebrew's jq, which a Homebrew-first guest reads JSON with
OA_GATE_BREW_JQ=/home/linuxbrew/.linuxbrew/opt/jq/bin/jq
# the due interval's default and limit, in days: DEFAULT_UPDATE_DUE_DAYS and
# MAX_UPDATE_DUE_DAYS in src/guest/update-schedule.ts
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
    -f /dev/stdin "$OA_GATE_ENVIRONMENT" <<'EOF'
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
# fragment, the tool helpers and the updater are all root's alone
# arguments: the OS family
oa_gate_update() {
  set -- "$OA_GATE_ROOT/os/$1/lib.sh" "$OA_GATE_ROOT/os/$1/update-system.sh" \
    "$OA_GATE_TOOLS/homebrew/lib.sh" "$OA_GATE_TOOLS/npm/lib.sh" \
    "$OA_GATE_TOOLS/rustup/lib.sh" "$OA_GATE_TOOLS/links.sh" "$OA_GATE_UPDATER"
  for oa_gate_library; do
    if ! oa_gate_trusted "$oa_gate_library"; then
      echo "Refusing $oa_gate_library: it is missing or not root's alone"
      return 1
    fi
  done
  /bin/sh -c '. "$1" && . "$2" && . "$3" && . "$4" && . "$5" && . "$6" && . "$7" &&
    shift 7 && oa_update_run "$@"' oa-updater "$@" \
    "$OA_GATE_ENVIRONMENT" "$OA_GATE_STATUS" "$oa_gate_jq" "$OA_GATE_AWAKE" "$$"
}

if test "$(id -u)" != 0; then
  echo 'update-gate.sh is root'"'"'s alone' >&2
  exit 77
fi
test -f "$OA_GATE_ENVIRONMENT" || exit 0

# one update at a time, in a lock directory no other account can reach
test -d "$OA_GATE_LOCK_DIRECTORY" || mkdir -m 0700 "$OA_GATE_LOCK_DIRECTORY" 2>/dev/null
if ! oa_gate_root_only "$OA_GATE_LOCK_DIRECTORY" ||
  test "$(stat -c %a "$OA_GATE_LOCK_DIRECTORY")" != 700; then
  echo "update gate: $OA_GATE_LOCK_DIRECTORY is not a directory root's alone" >&2
  exit 1
fi
exec 9>>"$OA_GATE_LOCK" || exit 1
flock -n 9 || exit 0

oa_gate_jq=$OA_GATE_BREW_JQ
test -x "$oa_gate_jq" || oa_gate_jq=$(command -v jq) || {
  echo "update gate: no jq reads $OA_GATE_ENVIRONMENT" >&2
  exit 1
}
oa_gate_last=$("$oa_gate_jq" -r '.lastSuccess | strings' "$OA_GATE_STATUS" 2>/dev/null) ||
  oa_gate_last=
oa_gate_due "$oa_gate_last"
case $? in
0) ;;
1) exit 0 ;;
*)
  echo "update gate: $OA_GATE_ENVIRONMENT cannot be read" >&2
  exit 1
  ;;
esac

oa_gate_family=$("$oa_gate_jq" -r '.os.family | strings' "$OA_GATE_ENVIRONMENT") || oa_gate_family=
case $oa_gate_family in
'' | *[!a-z0-9]*)
  echo "update gate: $OA_GATE_ENVIRONMENT records no OS family" >&2
  exit 1
  ;;
esac

# the run's output replaces the last one's, so the log holds one run
exec >"$OA_GATE_LOG" 2>&1 || exit 1
chmod 0600 "$OA_GATE_LOG"
"$OA_GATE_AWAKE" hold-open --source "$OA_GATE_HOLD" --session "$OA_GATE_HOLD" --pid "$$"
oa_gate_update "$oa_gate_family"
oa_gate_status=$?
"$OA_GATE_AWAKE" hold-close --source "$OA_GATE_HOLD" --session "$OA_GATE_HOLD" --pid "$$"
test "$oa_gate_status" = 0 || exit 1
