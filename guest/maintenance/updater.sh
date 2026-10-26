# open-agent's updater, root's alone: the update gate sources it after the
# family's library and update fragment, the Homebrew, npm and rustup helpers,
# the link helpers and the version record, and runs oa_update_run in a shell
# of its own. It upgrades every tool environment.json records through the
# manager its source names, never installing a missing one: the system
# packages together through the family's fragment, then each Homebrew formula
# from its bottle after one refresh, a formula whose new version has no bottle
# keeping its own, then each npm tool to its dist-tag and each Rust toolchain,
# both as the agent. Afterwards it records each tool's installed version in
# environment.json, restores the tools' links and records the run in
# update-status.json: when it started and finished, each tool's outcome with
# its versions before and after, and the last success, which moves only when
# every required tool was installed or skipped and the links were restored.
# It leaves every daemon as it is: it neither starts, stops nor signals one,
# and the family's fragment keeps the packages it upgrades from doing so.
# Between tools it renews the gate's awake hold, which a provider that keeps
# its own deadline only reads when told.
# Once the run is recorded it cleans up after the update, one manager at a
# time through the manager's own library: it removes what the update made
# outdated, such as the package files, kegs, downloads and runtimes of
# superseded versions, never a current one nor a cache or repository the user
# keeps. A cleanup never fails the update nor moves the last success; it is
# recorded under `cleanup` in update-status.json with its outcome (`cleaned`,
# `skipped` or `failed`) and the bytes it freed, and logged as one line,
# `open-agent-update <time> cleanup=<manager> outcome=<ok|skipped|failed>
# freed_mb=<n> duration_ms=<n>`, and is safe to rerun

# the format version of update-status.json
OA_UPDATER_SCHEMA=1

# prints the time as an ISO 8601 UTC timestamp
oa_updater_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# prints the milliseconds the machine has been up, which times a cleanup
oa_updater_ms() {
  awk '{ printf "%d\n", $1 * 1000 }' /proc/uptime
}

# renews the gate's awake hold
oa_updater_hold() {
  "$oa_updater_awake" hold-open --source update --session update --pid "$oa_updater_pid" || :
}

# writes update-status.json from the outcomes recorded so far, replacing the
# file at once so a reader never sees half of it
# arguments: when the run finished, empty while it runs; the last success,
# empty when none is
oa_updater_record() {
  oa_updater_record_file=$(mktemp "${oa_updater_status%/*}/.update-status.XXXXXX") || return 1
  if "$oa_updater_jq" -n -f "$oa_updater_work/status.jq" \
    --argjson schema "$OA_UPDATER_SCHEMA" --arg started "$oa_updater_started" \
    --arg finished "$1" --arg last "$2" --arg links "$oa_updater_links" \
    --rawfile tools "$oa_updater_work/outcomes" \
    --rawfile cleanups "$oa_updater_work/cleanups" >"$oa_updater_record_file" &&
    chmod 0644 "$oa_updater_record_file" &&
    mv -f "$oa_updater_record_file" "$oa_updater_status"; then
    return 0
  fi
  rm -f "$oa_updater_record_file"
  echo "Could not write $oa_updater_status"
  return 1
}

# records one tool's outcome: failed when its manager failed or its version
# cannot be read afterwards, installed when its version moved, and skipped
# otherwise
# arguments: name, manager, whether it is required, the manager's status,
# the version before and after, and why it failed or was skipped, if known
oa_updater_outcome() {
  if test "$4" != 0; then
    set -- "$1" "$2" "$3" failed "$5" "$6" "${7:-its $2 upgrade failed}"
  elif test -z "$6"; then
    set -- "$1" "$2" "$3" failed "$5" "$6" "its version cannot be read after the upgrade"
  elif test "$5" != "$6"; then
    set -- "$1" "$2" "$3" installed "$5" "$6" ''
  else
    set -- "$1" "$2" "$3" skipped "$5" "$6" "${7:-it is current}"
  fi
  echo "$1 ($2): $4${5:+ from $5}${6:+ to $6}${7:+: $7}"
  if test "$4" = failed && test "$3" = true; then
    oa_updater_failed=1
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" | tr -d '\r' >>"$oa_updater_work/outcomes"
}

# prints the tools environment.json records for one manager, one a line:
# name, whether it is required, the package, formula or toolchain, and the
# npm dist-tag
# arguments: the manager
oa_updater_tools() {
  "$oa_updater_jq" -r --arg kind "$1" -f "$oa_updater_work/tools.jq" "$oa_updater_environment"
}

# upgrades the system packages of every system tool at once, through the
# family's fragment, reading each tool's version from its first package
oa_updater_system() {
  oa_updater_system_tools=$(oa_updater_tools system) || return 1
  test -n "$oa_updater_system_tools" || return 0
  : >"$oa_updater_work/before"
  while IFS="$(printf '\t')" read -r oa_updater_name oa_updater_required oa_updater_package _ <&3; do
    oa_updater_from=$(oa_pkg_version "$oa_updater_package" 2>/dev/null) || oa_updater_from=
    printf '%s\t%s\n' "$oa_updater_name" "$oa_updater_from" >>"$oa_updater_work/before"
  done 3<<EOF
$oa_updater_system_tools
EOF
  oa_updater_hold
  oa_update_system "$oa_updater_environment"
  oa_updater_system_status=$?
  while IFS="$(printf '\t')" read -r oa_updater_name oa_updater_required oa_updater_package _ <&3; do
    oa_updater_from=$(awk -F '\t' -v name="$oa_updater_name" '$1 == name { print $2; exit }' \
      "$oa_updater_work/before")
    oa_updater_to=$(oa_pkg_version "$oa_updater_package" 2>/dev/null) || oa_updater_to=
    oa_updater_outcome "$oa_updater_name" system "$oa_updater_required" "$oa_updater_system_status" \
      "$oa_updater_from" "$oa_updater_to"
  done 3<<EOF
$oa_updater_system_tools
EOF
}

# refreshes Homebrew's formula data once, never its own code, then upgrades
# each formula from its bottle; one whose new version has no bottle keeps its
# own and counts as skipped
oa_updater_brew() {
  oa_updater_brew_tools=$(oa_updater_tools brew) || return 1
  test -n "$oa_updater_brew_tools" || return 0
  oa_updater_hold
  oa_updater_brew_refreshed=0
  if oa_brew_refresh; then
    oa_updater_brew_refreshed=1
  fi
  while IFS="$(printf '\t')" read -r oa_updater_name oa_updater_required oa_updater_formula _ <&3; do
    oa_updater_hold
    oa_updater_from=$(oa_brew_version "$oa_updater_formula" 2>/dev/null) || oa_updater_from=
    if test "$oa_updater_brew_refreshed" = 0; then
      oa_updater_outcome "$oa_updater_name" brew "$oa_updater_required" 1 \
        "$oa_updater_from" "$oa_updater_from" 'Homebrew could not refresh its formulae'
      continue
    fi
    oa_brew_upgrade "$oa_updater_formula" 2>"$oa_updater_work/brew"
    oa_updater_brew_status=$?
    cat "$oa_updater_work/brew" >&2
    oa_updater_reason=
    if grep -q "^Keeping $oa_updater_formula:" "$oa_updater_work/brew"; then
      oa_updater_reason="its new version has no bottle for $(uname -m)"
    fi
    oa_updater_to=$(oa_brew_version "$oa_updater_formula" 2>/dev/null) || oa_updater_to=
    oa_updater_outcome "$oa_updater_name" brew "$oa_updater_required" "$oa_updater_brew_status" \
      "$oa_updater_from" "$oa_updater_to" "$oa_updater_reason"
  done 3<<EOF
$oa_updater_brew_tools
EOF
}

# moves each npm tool to the version its dist-tag names now, as the agent
oa_updater_npm() {
  oa_updater_npm_tools=$(oa_updater_tools npm) || return 1
  while IFS="$(printf '\t')" read -r oa_updater_name oa_updater_required oa_updater_package oa_updater_tag <&3; do
    test -n "$oa_updater_name" || continue
    oa_updater_hold
    oa_updater_from=$(oa_npm_version "$oa_updater_package" 2>/dev/null) || oa_updater_from=
    oa_npm_upgrade "$oa_updater_package" "$oa_updater_tag"
    oa_updater_npm_status=$?
    oa_updater_to=$(oa_npm_version "$oa_updater_package" 2>/dev/null) || oa_updater_to=
    oa_updater_outcome "$oa_updater_name" npm "$oa_updater_required" "$oa_updater_npm_status" \
      "$oa_updater_from" "$oa_updater_to"
  done 3<<EOF
$oa_updater_npm_tools
EOF
}

# updates each Rust toolchain and its components, as the agent
oa_updater_rustup() {
  oa_updater_rustup_tools=$(oa_updater_tools rustup) || return 1
  while IFS="$(printf '\t')" read -r oa_updater_name oa_updater_required oa_updater_toolchain _ <&3; do
    test -n "$oa_updater_name" || continue
    oa_updater_hold
    oa_updater_from=$(oa_rustup_version "$oa_updater_toolchain" 2>/dev/null | cut -d ' ' -f 2)
    oa_rustup_update "$oa_updater_toolchain"
    oa_updater_rustup_status=$?
    oa_updater_to=$(oa_rustup_version "$oa_updater_toolchain" 2>/dev/null | cut -d ' ' -f 2)
    oa_updater_outcome "$oa_updater_name" rustup "$oa_updater_required" "$oa_updater_rustup_status" \
      "$oa_updater_from" "$oa_updater_to"
  done 3<<EOF
$oa_updater_rustup_tools
EOF
}

# prints the kilobytes the directories on its standard input use, one path a
# line, counting those that exist
oa_updater_used() {
  oa_used_total=0
  while IFS= read -r oa_used_dir; do
    test -d "$oa_used_dir" || continue
    oa_used_kb=$(du -sk -- "$oa_used_dir" 2>/dev/null | cut -f 1)
    oa_used_total=$((oa_used_total + ${oa_used_kb:-0}))
  done
  echo "$oa_used_total"
}

# cleans up after the update through one manager's library, whose
# oa_<manager>_clean_roots names the directories it shrinks and whose
# oa_<manager>_clean (the family's oa_update_system_clean for the system)
# removes the outdated and returns 0, 2 when the manager is not there, or
# another status when it failed, then records the outcome and the bytes the
# directories lost, and logs one line. It never sets the update's failure
# arguments: the manager
oa_updater_cleanup() {
  oa_cleanup_manager=$1
  case $oa_cleanup_manager in
    system) oa_cleanup_function=oa_update_system_clean ;;
    *) oa_cleanup_function=oa_${oa_cleanup_manager}_clean ;;
  esac
  oa_updater_hold
  oa_cleanup_began=$(oa_updater_ms)
  oa_cleanup_before=$("${oa_cleanup_function}_roots" | oa_updater_used)
  "$oa_cleanup_function"
  oa_cleanup_status=$?
  oa_cleanup_after=$("${oa_cleanup_function}_roots" | oa_updater_used)
  oa_cleanup_ended=$(oa_updater_ms)
  oa_cleanup_freed=$((oa_cleanup_before - oa_cleanup_after))
  if test "$oa_cleanup_freed" -lt 0; then
    oa_cleanup_freed=0
  fi
  case $oa_cleanup_status in
    0) set -- cleaned ok '' ;;
    2) set -- skipped skipped "its manager is not installed" ;;
    *) set -- failed failed "its cleanup failed" ;;
  esac
  oa_cleanup_millis=$((oa_cleanup_ended - oa_cleanup_began))
  printf 'open-agent-update %s cleanup=%s outcome=%s freed_mb=%s duration_ms=%s%s\n' \
    "$(oa_updater_now)" "$oa_cleanup_manager" "$2" "$((oa_cleanup_freed / 1024))" \
    "$oa_cleanup_millis" "${3:+ reason=\"$3\"}"
  printf '%s\t%s\t%s\t%s\t%s\n' "$oa_cleanup_manager" "$1" "$((oa_cleanup_freed * 1024))" \
    "$oa_cleanup_millis" "$3" | tr -d '\r' >>"$oa_updater_work/cleanups"
}

# runs one update: upgrades every recorded tool through its manager, restores
# the links, records the run and cleans up after it; it returns non-zero only
# when the run could not be recorded
# arguments: path of environment.json, path of update-status.json, jq, the
# awake command, and the pid the awake hold is keyed by
oa_update_run() {
  oa_updater_environment=$1
  oa_updater_status=$2
  oa_updater_jq=$3
  oa_updater_awake=$4
  oa_updater_pid=$5
  oa_updater_work=$(mktemp -d) || return 1
  trap 'rm -rf "$oa_updater_work"' EXIT
  trap 'exit 143' HUP INT TERM
  cat >"$oa_updater_work/tools.jq" <<'EOF'
.tools[]? | select(.source.kind == $kind)
| [.name, (.required | tostring),
   (.source | .packages[0] // .formula // .package // .toolchain // ""),
   (.source.distTag // "latest")]
| @tsv
EOF
  cat >"$oa_updater_work/status.jq" <<'EOF'
def present: if . == "" then null else . end;
{
  schema: $schema,
  startedAt: $started,
  finishedAt: ($finished | present),
  lastSuccess: ($last | present),
  links: ($links | present),
  tools: [
    $tools | split("\n")[] | select(. != "") | split("\t")
    | {name: .[0], manager: .[1], required: (.[2] == "true"), outcome: .[3],
       from: (.[4] | present), to: (.[5] | present)}
      + (if .[6] == "" then {} else {reason: .[6]} end)
  ],
  cleanup: [
    $cleanups | split("\n")[] | select(. != "") | split("\t")
    | {manager: .[0], outcome: .[1], freedBytes: (.[2] | tonumber), durationMs: (.[3] | tonumber)}
      + (if (.[4] // "") == "" then {} else {reason: .[4]} end)
  ]
}
EOF
  : >"$oa_updater_work/outcomes"
  : >"$oa_updater_work/cleanups"
  oa_updater_previous=$("$oa_updater_jq" -r '.lastSuccess | strings' "$oa_updater_status" 2>/dev/null) ||
    oa_updater_previous=
  oa_updater_started=$(oa_updater_now)
  oa_updater_links=
  oa_updater_failed=0
  echo "update started at $oa_updater_started"
  oa_updater_record '' "$oa_updater_previous" || return 1
  for oa_updater_manager in system brew npm rustup; do
    if ! "oa_updater_$oa_updater_manager"; then
      echo "the $oa_updater_manager tools cannot be read from $oa_updater_environment"
      oa_updater_failed=1
    fi
  done
  oa_updater_hold
  # the record follows what the upgrades installed; a failure to record it
  # leaves the update's outcome as it is, since every tool is still in place
  oa_tools_record_versions "$oa_updater_environment" ||
    echo "the tool versions could not be recorded in $oa_updater_environment"
  if oa_links_restore "$oa_updater_environment"; then
    oa_updater_links=restored
  else
    oa_updater_links=failed
    oa_updater_failed=1
  fi
  oa_updater_finished=$(oa_updater_now)
  oa_updater_last=$oa_updater_previous
  if test "$oa_updater_failed" = 0; then
    oa_updater_last=$oa_updater_finished
  fi
  echo "update finished at $oa_updater_finished; links $oa_updater_links; last success ${oa_updater_last:-none}"
  oa_updater_record "$oa_updater_finished" "$oa_updater_last" || return 1
  # the update is recorded, its last success included, before anything is
  # cleaned, so nothing a cleanup does reaches the verdict
  for oa_updater_manager in system brew npm rustup; do
    oa_updater_cleanup "$oa_updater_manager"
  done
  oa_updater_record "$oa_updater_finished" "$oa_updater_last"
}
