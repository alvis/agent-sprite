#!/bin/sh
# open-agent-awake, open-agent's idle governor: root's file, run by every
# account. A harness hook, as the agent, records an awake event
# (`heartbeat`, `hold-open` or `hold-close`) with `--source` and `--session`,
# the session `-` reading the hook's JSON input for its session_id; root
# records managed holds the same way, `--pid` naming the process whose run
# keeps the hold open. Every event is a heartbeat: `hold-open` opens or
# refreshes a turn hold, a heartbeat refreshes a hold still open and
# `hold-close` closes it. Each account keeps its holders in its own awake
# directory under its own state lock, run/awake for the agent and
# run/awake-root for root, and every event recomputes the awake deadline from
# both, the provider facts and the idle options environment.json records,
# then records the governor state, governor.json, in the caller's own awake
# directory, so root never writes where the agent can. The deadline is the last heartbeat plus the
# idle timeout, or the latest open hold, whichever is later; a managed hold
# lasts while its process runs and ends with it, and any other hold lasts at
# most the turn-hold maximum after its last refresh. A `native-deadline`
# provider gets every new deadline through its awake adapter, always as the
# agent; a `governed` one is put into an idle form by the per-minute root
# `tick` once the deadline passed, sleep is permitted and the workstation
# has been awake an idle timeout since it last woke, so nothing sleeps with
# a turn or hold open: the tick checks once more, and calls the adapter,
# under a governor lock no event holds meanwhile. An event runs within its budget, --budget-ms or 8
# seconds, and exits 0 whatever happens, except for an unknown action; a
# refused or failed event is recorded as a diagnostic, and an event that is
# not recorded counts as idleness. Root's `report` prints the newer of the
# two recorded states for the host, and root's `install` and `check` make
# and check the directories the governor keeps its state in. Every file it
# reads from an awake directory is data: it is read without following links,
# bounded and validated, and root takes nothing from the agent's directory
# but holders, so its own state never carries a field the agent wrote; a
# scan that cannot see every holder never lets the workstation sleep

set -u
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

# the guest root and what the governor keeps in it
OA_GUEST_ROOT=/opt/open-agent
OA_IDLE_ENVIRONMENT=$OA_GUEST_ROOT/environment.json
OA_IDLE_RUN=$OA_GUEST_ROOT/run
OA_IDLE_SHARED=$OA_IDLE_RUN/awake
OA_IDLE_MANAGED=$OA_IDLE_RUN/awake-root
# the governor state each account records in its own awake directory
OA_IDLE_STATE=governor.json
OA_IDLE_TICK=$OA_IDLE_RUN/idle-tick.json
# the governor lock: every event takes it shared, and the tick takes it
# alone across its last check and the adapter's call
OA_IDLE_LOCK=$OA_IDLE_RUN/governor.lock
# the account harness hooks run as
OA_IDLE_AGENT=agent
# a holder file's name, as find matches it
OA_IDLE_HOLDER_PATTERN='.*/h-[0-9a-f]{64}\.json'
# the limits of one awake directory scan, beyond which it fails closed
OA_IDLE_MAX_ENTRIES=8192
OA_IDLE_MAX_HOLDERS=512
OA_IDLE_HOLDER_BYTES=1024
OA_IDLE_STATE_BYTES=16384
OA_IDLE_TICK_BYTES=512
# the limits of an awake event, in milliseconds
OA_IDLE_DEFAULT_BUDGET_MS=8000
OA_IDLE_MIN_BUDGET_MS=1000
OA_IDLE_INPUT_WAIT_MS=1500
OA_IDLE_INPUT_BYTES=65536
# how long a state lock, or the governor lock shared, is waited for, and how
# long the tick waits for the governor lock alone, in seconds
OA_IDLE_LOCK_WAIT=3
OA_IDLE_EXCLUSIVE_WAIT=10
OA_IDLE_USAGE='usage: open-agent-awake <heartbeat|hold-open|hold-close> --source <name> --session <id|-> [--budget-ms <1000-8000>]'

# the jq definitions every computation shares: an instant as ISO 8601 with
# milliseconds, which the host round-trips, its epoch milliseconds back, and
# a diagnostic as recordable text of at most 240 UTF-16 units without
# control characters
OA_IDLE_JQ_DEFS=$(
  cat <<'EOF'
  def iso: (. / 1000 | floor) as $s
    | ($s | todate | rtrimstr("Z")) + "." + ("00" + (. - $s * 1000 | tostring))[-3:] + "Z";
  def instant: try (capture("\\A(?<s>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})\\.(?<ms>[0-9]{3})Z\\z")
    | (.s + "Z" | fromdate) * 1000 + (.ms | tonumber)) catch null;
  def isinstant: type == "string" and length <= 32 and (instant as $t | $t != null and ($t | iso) == .);
  def text: gsub("[[:cntrl:]]"; " ") | explode
    | reduce .[] as $c ({n: 0, o: [], full: false};
        if .full then . else (if $c > 65535 then 2 else 1 end) as $w
          | if .n + $w > 240 then .full = true else .n += $w | .o += [$c] end end)
    | .o | implode;
  def istext: type == "string" and length <= 240 and (test("[[:cntrl:]]") | not);
  def count: type == "number" and . >= 0 and . == floor;
  def lines: split("\n") | map(select(. != ""));
  def isadapter: type == "object" and (.at | isinstant)
    and (.action | IN("apply-deadline", "enter-idle-form"))
    and (has("result") != has("failure"))
    and ((.result // .failure) | istext);
EOF
)

# prints the current time in epoch milliseconds
oa_idle_now() {
  date +%s%3N
}

# prints a hex SHA-256 digest of a text, which is all a holder keeps of a
# session id
# arguments: the text
oa_idle_hash() {
  printf '%s' "$1" | sha256sum | cut -c 1-64
}

# prints the name of the holder file of a source and hashed session
# arguments: the source, the session hash
oa_idle_holder_name() {
  oa_idle_holder_name_digest=$({
    printf '%s' "$1"
    printf '\000'
    printf '%s' "$2"
  } | sha256sum | cut -c 1-64) || return 1
  printf 'h-%s.json\n' "$oa_idle_holder_name_digest"
}

# copies an untrusted file into the work directory without following a link
# or waiting on a pipe; it fails when the file is longer than its limit
# arguments: the file, its most bytes, the copy
oa_idle_read() {
  rm -f "$3"
  timeout 2 dd if="$1" of="$3" iflag=nofollow,nonblock bs="$(($2 + 1))" \
    count=1 status=none 2>/dev/null || return 1
  test "$(wc -c <"$3")" -le "$2"
}

# replaces a file in a directory with a copy, atomically; the directory is
# one only the caller can write, run or run/awake-root for root and
# run/awake for the agent, so no other account can plant a link the
# temporary or the rename would follow
# arguments: the copy's source, the directory, the file's name, its mode
oa_idle_place() {
  oa_idle_place_temporary=$(mktemp "$2/.tmp-XXXXXXXX") || return 1
  if cat "$1" >"$oa_idle_place_temporary" &&
    chmod "$4" "$oa_idle_place_temporary" &&
    mv -f "$oa_idle_place_temporary" "$2/$3"; then
    return 0
  fi
  rm -f "$oa_idle_place_temporary"
  return 1
}

# prints the start, in clock ticks since boot, of a running process that is
# not a zombie; returns 1 when the process table names no such process and 2
# when it cannot tell, as when /proc is not mounted
# arguments: the process id
oa_idle_process_start() {
  case $1 in '' | *[!0-9]*) return 1 ;; esac
  if ! oa_idle_process_start_stat=$(cat "/proc/$1/stat" 2>/dev/null); then
    if test -d /proc/self && ! test -e "/proc/$1"; then
      return 1
    fi
    return 2
  fi
  # the command name can hold any character, so the fields after it are
  # counted from its closing parenthesis: the state first, the start 20th
  oa_idle_process_start_fields=$(printf '%s\n' "${oa_idle_process_start_stat##*) }" |
    cut -d ' ' -f 1,20)
  case $oa_idle_process_start_fields in
  'Z '* | '' | *' ') return 1 ;;
  esac
  printf '%s\n' "${oa_idle_process_start_fields#* }"
}

# writes settings.json to the work directory: the provider facts
# environment.json records, the idle timeout and turn-hold maximum, already
# capped at the provider's deadline limit by setup, and the notes on what
# is missing; with no valid provider recorded the defaults apply. No jq
# variable is named after a keyword, which Debian 12's jq 1.6 rejects
oa_idle_settings() {
  if /usr/bin/jq -c "$OA_IDLE_JQ_DEFS"'
    def minutes($v; $least; $default; $setting):
      if ($v | count) and $v >= $least then {v: $v}
      else {v: $default, note: "stored \($setting) is missing or invalid; the default of \($default) minutes applies"} end;
    (.provider // null) as $p
    | if ($p | type) != "object" or ($p.keepAwakeMode | IN("native-deadline", "governed", "none") | not) then
        error("no provider")
      else
        minutes($p.idleTimeoutMinutes; 0; 5; "idle timeout") as $i
        | minutes($p.holdMaxMinutes; 1; 60; "turn-hold maximum") as $h
        | ($p.awakeAdapter | type == "string" and startswith("/opt/open-agent/") and (contains("/../") | not)) as $adapter
        | {
            provider: {
              keepAwakeMode: $p.keepAwakeMode,
              wakeMode: $p.wakeMode,
              supportsCliWakeSleep: ($p.supportsCliWakeSleep == true),
              awakeAdapter: (if $adapter then $p.awakeAdapter else null end)
            },
            idle: $i.v,
            holdMax: $h.v,
            notes: (([$i.note, $h.note] | map(select(. != null)))
              + (if $p.keepAwakeMode != "none" and ($adapter | not)
                 then ["the provider declares no awake adapter, so only state is recorded"] else [] end))
          }
      end' "$OA_IDLE_ENVIRONMENT" >"$OA_IDLE_WORK/settings.json" 2>/dev/null; then
    return 0
  fi
  printf '%s\n' '{"provider":null,"idle":5,"holdMax":60,"notes":["no provider is recorded yet, so only state is recorded"]}' \
    >"$OA_IDLE_WORK/settings.json"
}

# prints one field of the settings
# arguments: the jq path of the field
oa_idle_setting() {
  /usr/bin/jq -r "$1 // empty" "$OA_IDLE_WORK/settings.json"
}

# validates a holder file's copy and prints its identity line, its source,
# session hash, process id and process start, then the holder as JSON with
# its name and directory; it fails on anything that is not a holder
# arguments: the copy, the file's name, whether its directory is the managed one
oa_idle_holder() {
  /usr/bin/jq -er --arg name "$2" --argjson managed "$3" "$OA_IDLE_JQ_DEFS"'
    select(type == "object" and .version == 1
      and (.source | type == "string" and test("\\A[a-z][a-z0-9-]{0,31}\\z"))
      and (.session | type == "string" and test("\\A[0-9a-f]{64}\\z"))
      and (.lastHeartbeat | count)
      and ((has("holdExpiresAt") | not) or (.holdExpiresAt | count))
      and (has("pid") == has("processStart"))
      and ((has("pid") | not) or ($managed and (.pid | count) and .pid > 0 and (.processStart | count))))
    | "\(.source) \(.session) \(.pid // "-") \(.processStart // "-")",
      ({source, session, lastHeartbeat, holdExpiresAt, name: $name, managed: $managed} | tojson)' "$1"
}

# scans one awake directory: appends each valid holder to holders, as a line
# of JSON, the name of each managed hold whose process runs to live, and,
# when the directory is the caller's own, the name of each holder file a
# prune removes to prune; it adds a note to found for an incomplete scan or
# for invalid holder files, and returns 1 when the scan is incomplete
# arguments: the directory, its label, the owner ids it accepts separated by
# spaces, whether it is the managed one, whether it is the caller's own
oa_idle_scan() {
  oa_idle_scan_problem=
  if ! test -d "$1" || test -L "$1"; then
    oa_idle_scan_problem='the directory is missing'
  else
    oa_idle_scan_entries=$(find "$1" -mindepth 1 -maxdepth 1 -printf . 2>/dev/null |
      head -c "$((OA_IDLE_MAX_ENTRIES + 1))" | wc -c)
    if test "$oa_idle_scan_entries" -gt "$OA_IDLE_MAX_ENTRIES"; then
      oa_idle_scan_problem="it holds more than $OA_IDLE_MAX_ENTRIES entries"
    elif ! find "$1" -mindepth 1 -maxdepth 1 -regextype posix-extended \
      -regex "$OA_IDLE_HOLDER_PATTERN" -printf '%y %n %U %s %f\n' \
      >"$OA_IDLE_WORK/listing" 2>/dev/null; then
      oa_idle_scan_problem='it cannot be listed'
    elif test "$(wc -l <"$OA_IDLE_WORK/listing")" -gt "$OA_IDLE_MAX_HOLDERS"; then
      oa_idle_scan_problem="it holds more than $OA_IDLE_MAX_HOLDERS holder files"
    fi
  fi
  if test -n "$oa_idle_scan_problem"; then
    printf 'the %s awake directory scan is incomplete, so sleep is not permitted: %s\n' \
      "$2" "$oa_idle_scan_problem" >>"$OA_IDLE_WORK/found"
    return 1
  fi
  oa_idle_scan_refused=0
  while read -r oa_idle_scan_type oa_idle_scan_links oa_idle_scan_owner oa_idle_scan_size oa_idle_scan_name; do
    oa_idle_scan_kept=
    case " $3 " in *" $oa_idle_scan_owner "*) oa_idle_scan_owned=1 ;; *) oa_idle_scan_owned= ;; esac
    if test "$oa_idle_scan_type $oa_idle_scan_links" = 'f 1' &&
      test -n "$oa_idle_scan_owned" &&
      test "$oa_idle_scan_size" -le "$OA_IDLE_HOLDER_BYTES" &&
      oa_idle_read "$1/$oa_idle_scan_name" "$OA_IDLE_HOLDER_BYTES" "$OA_IDLE_WORK/holder" &&
      oa_idle_holder "$OA_IDLE_WORK/holder" "$oa_idle_scan_name" "$4" >"$OA_IDLE_WORK/parsed" 2>/dev/null; then
      {
        read -r oa_idle_scan_source oa_idle_scan_session oa_idle_scan_pid oa_idle_scan_start
        read -r oa_idle_scan_json
      } <"$OA_IDLE_WORK/parsed"
      if test "$(oa_idle_holder_name "$oa_idle_scan_source" "$oa_idle_scan_session")" = "$oa_idle_scan_name"; then
        oa_idle_scan_kept=1
      fi
    fi
    if test -z "$oa_idle_scan_kept"; then
      oa_idle_scan_refused=$((oa_idle_scan_refused + 1))
      test "$5" = true && printf '%s\n' "$oa_idle_scan_name" >>"$OA_IDLE_WORK/prune"
      continue
    fi
    if test "$oa_idle_scan_pid" != -; then
      # a managed hold lasts while its process runs and ends with it; a
      # process table that cannot tell neither ends nor refreshes it
      oa_idle_scan_status=0
      oa_idle_scan_running=$(oa_idle_process_start "$oa_idle_scan_pid") || oa_idle_scan_status=$?
      if test "$oa_idle_scan_status" -eq 1 ||
        { test "$oa_idle_scan_status" -eq 0 && test "$oa_idle_scan_running" != "$oa_idle_scan_start"; }; then
        test "$5" = true && printf '%s\n' "$oa_idle_scan_name" >>"$OA_IDLE_WORK/prune"
        continue
      fi
      test "$oa_idle_scan_status" -eq 0 && printf '%s\n' "$oa_idle_scan_name" >>"$OA_IDLE_WORK/live"
    fi
    printf '%s\n' "$oa_idle_scan_json" >>"$OA_IDLE_WORK/holders"
  done <"$OA_IDLE_WORK/listing"
  if test "$oa_idle_scan_refused" -gt 0; then
    printf 'ignored %s invalid holder file(s) in the %s awake directory\n' \
      "$oa_idle_scan_refused" "$2" >>"$OA_IDLE_WORK/found"
  fi
}

# records the pending event's holder in the caller's own awake directory;
# only root records a process, and only with a hold
# arguments: current epoch milliseconds
oa_idle_record_event() {
  oa_idle_record_event_hash=$(oa_idle_hash "$oa_idle_session") &&
    oa_idle_record_event_name=$(oa_idle_holder_name "$oa_idle_source" "$oa_idle_record_event_hash") ||
    return 1
  oa_idle_record_event_expiry=0
  if test -f "$oa_idle_own/$oa_idle_record_event_name" &&
    oa_idle_read "$oa_idle_own/$oa_idle_record_event_name" "$OA_IDLE_HOLDER_BYTES" "$OA_IDLE_WORK/holder"; then
    oa_idle_record_event_expiry=$(/usr/bin/jq -r 'if type == "object" and (.holdExpiresAt | type) == "number" then .holdExpiresAt else 0 end' \
      "$OA_IDLE_WORK/holder" 2>/dev/null) || oa_idle_record_event_expiry=0
  fi
  /usr/bin/jq -nc --arg source "$oa_idle_source" --arg session "$oa_idle_record_event_hash" \
    --argjson now "$1" --argjson holdMax "$(oa_idle_setting .holdMax)" \
    --arg action "$oa_idle_action" --argjson expiry "$oa_idle_record_event_expiry" \
    --arg pid "$oa_idle_pid" --arg start "$oa_idle_pid_start" '
    ($action == "hold-open" or ($action == "heartbeat" and $expiry > $now)) as $keeps
    | {version: 1, source: $source, session: $session, lastHeartbeat: $now}
      + (if $keeps then {holdExpiresAt: ($now + $holdMax * 60000)}
          + (if $pid != "" then {pid: ($pid | tonumber), processStart: ($start | tonumber)} else {} end)
        else {} end)' >"$OA_IDLE_WORK/event" &&
    oa_idle_place "$OA_IDLE_WORK/event" "$oa_idle_own" "$oa_idle_record_event_name" 0640
}

# copies the governor state an account recorded in its awake directory to a
# file in the work directory, or empties it when there is none to trust
# arguments: the awake directory, the id of the account that owns it, the
# copy's name
oa_idle_read_state() {
  : >"$OA_IDLE_WORK/$3"
  if test "$(find "$1/$OA_IDLE_STATE" -maxdepth 0 -type f -links 1 -printf '%U' 2>/dev/null)" != "$2" ||
    ! oa_idle_read "$1/$OA_IDLE_STATE" "$OA_IDLE_STATE_BYTES" "$OA_IDLE_WORK/state-copy" ||
    ! /usr/bin/jq -c 'select(type == "object")' "$OA_IDLE_WORK/state-copy" >"$OA_IDLE_WORK/$3" 2>/dev/null; then
    : >"$OA_IDLE_WORK/$3"
  fi
}

# recomputes the governor state into computed.json in the work directory:
# the pending event first, when there is one, then the holders of both
# awake directories, the settings and the last heartbeat and adapter result
# of the state the caller recorded before, which an adapter result in
# adapter.json replaces.
# With pruning, which needs the caller's state lock, it removes the
# invalid, spent and foreign entries of the caller's own directory
# arguments: whether to prune (prune or keep), whether to record the state (record or keep)
oa_idle_recompute() {
  for oa_idle_recompute_file in holders live prune found; do
    : >"$OA_IDLE_WORK/$oa_idle_recompute_file"
  done
  oa_idle_recompute_now=$(oa_idle_now)
  oa_idle_settings
  if test -n "$oa_idle_action"; then
    if ! oa_idle_record_event "$oa_idle_recompute_now" 2>"$OA_IDLE_WORK/event-error"; then
      oa_idle_event_failure="the $oa_idle_action event was not recorded, which counts as idleness: $(head -c 160 "$OA_IDLE_WORK/event-error" | tr '\n' ' ')"
      test -s "$OA_IDLE_WORK/event-error" ||
        oa_idle_event_failure="${oa_idle_event_failure}its holder could not be written"
    fi
    oa_idle_action=
  fi
  if test -n "$oa_idle_event_failure"; then
    printf '%s\n' "$oa_idle_event_failure" >>"$OA_IDLE_WORK/found"
  fi
  oa_idle_recompute_incomplete=false
  oa_idle_recompute_shared_own=false
  oa_idle_recompute_managed_own=false
  if test "$1" = prune; then
    oa_idle_recompute_shared_own=true
    if test "$oa_idle_as_root" = true; then
      oa_idle_recompute_shared_own=false
      oa_idle_recompute_managed_own=true
    fi
  fi
  oa_idle_scan "$OA_IDLE_SHARED" shared "$oa_idle_agent_uid" false "$oa_idle_recompute_shared_own" ||
    oa_idle_recompute_incomplete=true
  oa_idle_scan "$OA_IDLE_MANAGED" managed 0 true "$oa_idle_recompute_managed_own" ||
    oa_idle_recompute_incomplete=true
  oa_idle_read_state "$oa_idle_own" "$oa_idle_uid" previous.json
  test -f "$OA_IDLE_WORK/adapter.json" || : >"$OA_IDLE_WORK/adapter.json"
  /usr/bin/jq -nc --slurpfile holders "$OA_IDLE_WORK/holders" \
    --slurpfile settings "$OA_IDLE_WORK/settings.json" \
    --slurpfile previous "$OA_IDLE_WORK/previous.json" \
    --slurpfile adapter "$OA_IDLE_WORK/adapter.json" \
    --rawfile notes "$OA_IDLE_WORK/notes" --rawfile found "$OA_IDLE_WORK/found" \
    --rawfile live "$OA_IDLE_WORK/live" \
    --argjson now "$oa_idle_recompute_now" --argjson asRoot "$oa_idle_as_root" \
    --argjson incomplete "$oa_idle_recompute_incomplete" "$OA_IDLE_JQ_DEFS"'
    $settings[0] as $set
    | $set.provider as $p
    | ($now + $set.holdMax * 60000) as $limit
    | ($live | lines) as $alive
    | ($previous[0] // {}) as $prev
    | (if $prev.lastHeartbeat | isinstant then $prev.lastHeartbeat | instant else null end) as $recorded
    | def holdOf:
        if .name | IN($alive[]) then $limit
        elif .holdExpiresAt != null then [.holdExpiresAt, $limit] | min
        else null end;
      def deadline($hs; $rec):
        ($hs | map(select(.lastHeartbeat <= $now + 60000))) as $credible
        | ([$credible[].lastHeartbeat]
            + (if $rec != null and $rec <= $now + 60000 then [$rec] else [] end)
            | map([., $now] | min) | max) as $last
        | ([$credible[] | {source, session, expiresAt: holdOf}
            | select(.expiresAt != null and .expiresAt > $now)] | sort_by(-.expiresAt)) as $holds
        | {
            last: $last,
            holds: $holds,
            deadline: ((if $set.idle > 0 and $last != null then [$last + $set.idle * 60000] else [] end)
              + [$holds[].expiresAt] | max)
          };
      deadline($holders; $recorded) as $d
    | (if ($adapter | length) > 0 then $adapter[0]
       elif $prev.adapter | isadapter then $prev.adapter else null end) as $result
    | (($incomplete | not) and $p != null and $p.keepAwakeMode == "governed" and $set.idle > 0
        and ($p.wakeMode == "url-traffic" or ($p.wakeMode == "cli-restore" and $p.supportsCliWakeSleep))) as $permitted
    | {
        deadline: $d.deadline,
        spent: [$holders[] | select(.managed == $asRoot)
          | select(deadline([.]; null) | (.holds | length) == 0 and (.deadline == null or .deadline <= $now))
          | .name],
        state: ({version: 1, updatedAt: ($now | iso)}
          + (if $p != null then {keepAwakeMode: $p.keepAwakeMode} else {} end)
          + {idleTimeoutMinutes: $set.idle, holdMaxMinutes: $set.holdMax}
          + (if $d.last != null then {lastHeartbeat: ($d.last | iso)} else {} end)
          + {
              holds: [$d.holds[:32][] | {source, session, expiresAt: (.expiresAt | iso)}],
              openHolds: ($d.holds | length)
            }
          + (if $d.deadline != null then {deadline: ($d.deadline | iso)} else {} end)
          + {sleepPermitted: $permitted}
          + (if $result != null then {adapter: $result} else {} end)
          + {diagnostics: ((($notes | lines) + $set.notes + ($found | lines))[:8] | map(text))})
      }' >"$OA_IDLE_WORK/computed.json" || return 1
  if test "$1" = prune; then
    /usr/bin/jq -r '.spent[]' "$OA_IDLE_WORK/computed.json" >>"$OA_IDLE_WORK/prune"
    oa_idle_prune
  fi
  if test "$2" = record; then
    /usr/bin/jq -c .state "$OA_IDLE_WORK/computed.json" >"$OA_IDLE_WORK/state.json" &&
      oa_idle_place "$OA_IDLE_WORK/state.json" "$oa_idle_own" "$OA_IDLE_STATE" 0640
  fi
}

# prunes the caller's own awake directory: the holder files the recompute
# named, temporaries abandoned for a minute and every entry that is neither
# a holder nor one of the governor's own files
oa_idle_prune() {
  while read -r oa_idle_prune_name; do
    case $oa_idle_prune_name in h-*.json) rm -rf -- "${oa_idle_own:?}/$oa_idle_prune_name" ;; esac
  done <"$OA_IDLE_WORK/prune"
  find "$oa_idle_own" -mindepth 1 -maxdepth 1 -name '.tmp-*' ! -newermt '60 seconds ago' \
    -exec rm -rf -- {} + 2>/dev/null
  find "$oa_idle_own" -mindepth 1 -maxdepth 1 -regextype posix-extended \
    ! -regex "$OA_IDLE_HOLDER_PATTERN" ! -name "$OA_IDLE_STATE" ! -name .lock \
    ! -name .apply.lock ! -name '.tmp-*' -exec rm -rf -- {} + 2>/dev/null
  return 0
}

# runs a function under the governor lock, shared, then the caller's state
# lock; when either is not taken it sets oa_idle_lock_failure and returns 1
# arguments: the function and its arguments
oa_idle_locked() {
  oa_idle_lock_failure="the awake state could not be recorded under its lock: the governor lock $OA_IDLE_LOCK is missing"
  test -f "$OA_IDLE_LOCK" || return 1
  oa_idle_lock_failure="the awake state could not be recorded under its lock: the lock was not taken within $OA_IDLE_LOCK_WAIT s"
  {
    flock -s -w "$OA_IDLE_LOCK_WAIT" 7 || return 1
    {
      flock -w "$OA_IDLE_LOCK_WAIT" 9 || return 1
      oa_idle_lock_failure=
      "$@"
    } 9>>"$oa_idle_own/.lock"
  } 7<"$OA_IDLE_LOCK"
}

# runs a function under the governor lock alone, which no event holds
# meanwhile; when it is not taken it sets oa_idle_lock_failure and returns 1
# arguments: the function and its arguments
oa_idle_exclusive() {
  oa_idle_lock_failure="no idle form was entered: the governor lock $OA_IDLE_LOCK is missing"
  test -f "$OA_IDLE_LOCK" || return 1
  oa_idle_lock_failure="no idle form was entered: awake events held the governor lock for $OA_IDLE_EXCLUSIVE_WAIT s"
  {
    flock -w "$OA_IDLE_EXCLUSIVE_WAIT" 7 || return 1
    oa_idle_lock_failure=
    "$@"
  } 7<"$OA_IDLE_LOCK"
}

# records the governor state under the caller's state lock, pruning its own
# directory, or, when the lock is not taken, records it without pruning and
# with the lock failure noted
oa_idle_record() {
  oa_idle_locked oa_idle_recompute prune record && return 0
  test -n "$oa_idle_lock_failure" || return 1
  printf '%s\n' "$oa_idle_lock_failure" >>"$OA_IDLE_WORK/notes"
  oa_idle_recompute keep record
}

# turns an adapter's idle-form answer into an adapter result in adapter.json
# arguments: the answer's file, the adapter's exit status
oa_idle_idle_form_result() {
  oa_idle_idle_form_line=$(head -n 1 "$1")
  oa_idle_idle_form_in_flight=
  case $2:$oa_idle_idle_form_line in
  124:* | 137:*)
    oa_idle_idle_form_in_flight=1
    set -- failure 'the adapter did not finish within 60000 ms'
    ;;
  *:'entered '?*) set -- result "${oa_idle_idle_form_line#entered }" ;;
  *:'unknown '?*) set -- result "unknown: ${oa_idle_idle_form_line#unknown }" ;;
  *:'failure '?*) set -- failure "${oa_idle_idle_form_line#failure }" ;;
  *) set -- failure "the adapter exited $2 without naming an idle form" ;;
  esac
  /usr/bin/jq -nc --argjson now "$(oa_idle_now)" --arg field "$1" --arg value "$2" "$OA_IDLE_JQ_DEFS"'
    {at: ($now | iso), action: "enter-idle-form", ($field): ($value | text)}' >"$OA_IDLE_WORK/adapter.json"
}

# prints the awake time and idle-form marker of the tick record, separated
# by a space, the marker empty when there is none: the awake time restarts
# at now after a reboot, a resume the boot clock shows or a gap of three
# minutes between ticks, and the marker survives only a continuous run
# arguments: current epoch milliseconds
oa_idle_read_tick() {
  oa_idle_read_tick_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || oa_idle_read_tick_boot=
  oa_idle_read_tick_uptime=$(cut -d ' ' -f 1 /proc/uptime 2>/dev/null) || oa_idle_read_tick_uptime=
  : >"$OA_IDLE_WORK/tick-copy"
  if test "$(find "$OA_IDLE_TICK" -maxdepth 0 -type f -links 1 -user 0 2>/dev/null)" = "$OA_IDLE_TICK"; then
    oa_idle_read "$OA_IDLE_TICK" "$OA_IDLE_TICK_BYTES" "$OA_IDLE_WORK/tick-copy" ||
      : >"$OA_IDLE_WORK/tick-copy"
  fi
  /usr/bin/jq -nr --rawfile raw "$OA_IDLE_WORK/tick-copy" --argjson now "$1" \
    --arg boot "$oa_idle_read_tick_boot" --arg uptime "$oa_idle_read_tick_uptime" '
    def past: type == "number" and . <= $now;
    (try ($raw | fromjson) catch {}) as $read
    | (if ($read | type) == "object" then $read else {} end) as $r
    | (if $boot == "" or $uptime == "" then true
       elif $r.bootId == $boot and ($r.uptimeMs | type) == "number" and ($r.lastTickAt | past) then
         (($uptime | tonumber) * 1000 | floor) - $r.uptimeMs
         | . >= 0 and $now - $r.lastTickAt - . <= 10000
       else false end) as $continuous
    | (if $continuous and ($r.lastTickAt | past) and ($r.awakeSince | past)
       then $now - $r.lastTickAt <= 180000 else false end) as $grace
    | "\(if $grace then $r.awakeSince else $now end) \(if $continuous and ($r.enteringSince | past) then $r.enteringSince else "" end)"'
}

# writes the tick record, root's alone, with the boot clock it was taken at
# arguments: the last tick, the awake time or empty, the idle-form marker or empty
oa_idle_write_tick() {
  oa_idle_write_tick_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || oa_idle_write_tick_boot=
  oa_idle_write_tick_uptime=$(cut -d ' ' -f 1 /proc/uptime 2>/dev/null) || oa_idle_write_tick_uptime=
  /usr/bin/jq -nc --argjson last "$1" --arg awake "$2" --arg entering "$3" \
    --arg boot "$oa_idle_write_tick_boot" --arg uptime "$oa_idle_write_tick_uptime" '
    {lastTickAt: $last}
    + (if $awake != "" then {awakeSince: ($awake | tonumber)} else {} end)
    + (if $entering != "" then {enteringSince: ($entering | tonumber)} else {} end)
    + (if $boot != "" and $uptime != "" then {bootId: $boot, uptimeMs: (($uptime | tonumber) * 1000 | floor)} else {} end)' \
    >"$OA_IDLE_WORK/tick.json" &&
    oa_idle_place "$OA_IDLE_WORK/tick.json" "$OA_IDLE_RUN" idle-tick.json 0600
}

# prints whether the recomputed state puts a governed workstation into its
# idle form: it has an adapter, sleep is permitted, no earlier call may
# still run, the deadline passed and it has been awake an idle timeout
# arguments: current epoch milliseconds, the awake time, whether an earlier
# call may still run (true or false)
oa_idle_due() {
  /usr/bin/jq -r --argjson now "$1" --argjson awake "$2" --argjson inFlight "$3" \
    --slurpfile settings "$OA_IDLE_WORK/settings.json" '
    $settings[0] as $set
    | $set.provider.keepAwakeMode == "governed" and $set.provider.awakeAdapter != null
      and .state.sleepPermitted and ($inFlight | not)
      and (.deadline == null or .deadline <= $now)
      and $awake + $set.idle * 60000 <= $now' "$OA_IDLE_WORK/computed.json"
}

# the first section of a tick, under root's state lock: recomputes and
# records the state, decides whether an idle form is due and marks it in
# the tick record; it sets oa_idle_tick_due, oa_idle_tick_awake and
# oa_idle_tick_marked
oa_idle_tick_decide() {
  oa_idle_tick_decide_now=$(oa_idle_now)
  oa_idle_tick_decide_read=$(oa_idle_read_tick "$oa_idle_tick_decide_now") || return 1
  oa_idle_tick_decide_awake=${oa_idle_tick_decide_read%% *}
  oa_idle_tick_decide_entering=${oa_idle_tick_decide_read#* }
  oa_idle_tick_decide_in_flight=false
  if test -n "$oa_idle_tick_decide_entering" &&
    test "$((oa_idle_tick_decide_now - oa_idle_tick_decide_entering))" -lt 120000; then
    oa_idle_tick_decide_in_flight=true
    echo 'an earlier idle-form call may still be running, so none is started' >>"$OA_IDLE_WORK/notes"
  fi
  oa_idle_recompute prune keep || return 1
  oa_idle_tick_awake=$oa_idle_tick_decide_awake
  oa_idle_tick_due=$(oa_idle_due "$oa_idle_tick_decide_now" "$oa_idle_tick_awake" \
    "$oa_idle_tick_decide_in_flight") || return 1
  if test "$oa_idle_tick_due" = true; then
    oa_idle_tick_marked=$oa_idle_tick_decide_now
  elif test "$oa_idle_tick_decide_in_flight" = true; then
    oa_idle_tick_marked=$oa_idle_tick_decide_entering
  else
    oa_idle_tick_marked=
  fi
  oa_idle_write_tick "$oa_idle_tick_decide_now" "$oa_idle_tick_decide_awake" "$oa_idle_tick_marked"
  /usr/bin/jq -c .state "$OA_IDLE_WORK/computed.json" >"$OA_IDLE_WORK/state.json" &&
    oa_idle_place "$OA_IDLE_WORK/state.json" "$oa_idle_own" "$OA_IDLE_STATE" 0640
}

# the last section of a tick that found an idle form due, under root's
# state lock: records the state with the adapter's result and settles the tick
# record. The marker stays while the call may still run, and is cleared
# only by the tick that set it; an entered idle form, or a call that ended
# without an answer and may have frozen the machine, keeps no awake time, so
# the first tick after a resume starts the idle timeout anew
oa_idle_tick_settle() {
  oa_idle_recompute prune record || return 1
  oa_idle_tick_settle_now=$(oa_idle_now)
  oa_idle_tick_settle_read=$(oa_idle_read_tick "$oa_idle_tick_settle_now") || return 1
  oa_idle_tick_settle_awake=${oa_idle_tick_settle_read%% *}
  oa_idle_tick_settle_marked=${oa_idle_tick_settle_read#* }
  if test -s "$OA_IDLE_WORK/adapter.json" && /usr/bin/jq -e 'has("result")' "$OA_IDLE_WORK/adapter.json" >/dev/null; then
    oa_idle_tick_settle_awake=
  fi
  if test -z "$oa_idle_idle_form_in_flight" && test "$oa_idle_tick_settle_marked" = "$oa_idle_tick_marked"; then
    oa_idle_tick_settle_marked=
  fi
  oa_idle_write_tick "$oa_idle_tick_settle_now" "$oa_idle_tick_settle_awake" "$oa_idle_tick_settle_marked"
}

# the middle section of a tick that found an idle form due, under the
# governor lock alone: recomputes the state once more and enters the idle
# form through the adapter only while it is still due. Whatever an event
# recorded before this check keeps the workstation awake; an event meanwhile
# waits for the lock, or records itself without it once its wait ran out,
# and then counts after the resume
oa_idle_tick_enter() {
  oa_idle_recompute keep keep || return 1
  if test "$(oa_idle_due "$(oa_idle_now)" "$oa_idle_tick_awake" false)" != true; then
    echo 'activity arrived after the idle decision, so no idle form was entered' >>"$OA_IDLE_WORK/notes"
    return 0
  fi
  oa_idle_tick_adapter=$(oa_idle_setting .provider.awakeAdapter)
  : >"$OA_IDLE_WORK/answer"
  oa_idle_tick_status=0
  timeout -k 5 60 /bin/sh "$oa_idle_tick_adapter" enter-idle-form \
    >"$OA_IDLE_WORK/answer" 2>/dev/null </dev/null || oa_idle_tick_status=$?
  oa_idle_idle_form_result "$OA_IDLE_WORK/answer" "$oa_idle_tick_status"
}

# the per-minute tick, root's alone: records the state and, once due, checks
# again and puts the workstation into its idle form through the adapter
# under the governor lock alone, then records the outcome
oa_idle_tick() {
  if ! oa_idle_locked oa_idle_tick_decide; then
    test -n "$oa_idle_lock_failure" &&
      printf '%s\n' "$oa_idle_lock_failure" >>"$OA_IDLE_WORK/notes"
    oa_idle_recompute keep record
    return 0
  fi
  test "$oa_idle_tick_due" = true || return 0
  : >"$OA_IDLE_WORK/notes"
  rm -f "$OA_IDLE_WORK/adapter.json"
  if ! oa_idle_exclusive oa_idle_tick_enter && test -n "$oa_idle_lock_failure"; then
    printf '%s\n' "$oa_idle_lock_failure" >>"$OA_IDLE_WORK/notes"
  fi
  if ! oa_idle_locked oa_idle_tick_settle; then
    test -n "$oa_idle_lock_failure" &&
      printf '%s\n' "$oa_idle_lock_failure" >>"$OA_IDLE_WORK/notes"
    oa_idle_recompute keep record
  fi
  return 0
}

# applies the current deadline once through a native-deadline adapter and
# writes the adapter result to adapter.json; it sets oa_idle_apply_target to
# the deadline applied, 0 for a release
oa_idle_apply_once() {
  oa_idle_recompute keep keep || return 1
  oa_idle_apply_adapter=$(oa_idle_setting .provider.awakeAdapter)
  if test "$(oa_idle_setting .provider.keepAwakeMode)" != native-deadline || test -z "$oa_idle_apply_adapter"; then
    oa_idle_apply_target=0
    printf '%s\n' 'the recorded provider does not apply deadlines' >"$OA_IDLE_WORK/apply-failure"
    return 1
  fi
  oa_idle_apply_target=$(/usr/bin/jq -r '.deadline // 0' "$OA_IDLE_WORK/computed.json")
  oa_idle_apply_status=0
  timeout -k 0.1 1.4 /bin/sh "$oa_idle_apply_adapter" apply-deadline "$oa_idle_apply_target" \
    >"$OA_IDLE_WORK/apply-failure" 2>&1 </dev/null || oa_idle_apply_status=$?
  case $oa_idle_apply_status in
  0) return 0 ;;
  124 | 137) printf '%s\n' 'the adapter did not finish within 1400 ms' >"$OA_IDLE_WORK/apply-failure" ;;
  esac
  test -s "$OA_IDLE_WORK/apply-failure" ||
    printf 'the adapter exited %s\n' "$oa_idle_apply_status" >"$OA_IDLE_WORK/apply-failure"
  return 1
}

# applies the current deadline through the native-deadline adapter, as the
# agent alone, under the apply lock, and prints the adapter result; an apply
# that succeeded is repeated while the deadline moved under it and it
# started within 800 ms
oa_idle_apply() {
  rm -f "$OA_IDLE_WORK/adapter.json"
  if test "$oa_idle_uid" -eq 0; then
    oa_idle_apply_answer failure 'a native-deadline adapter never runs as root'
    return
  fi
  {
    if ! flock -w 0.4 8; then
      oa_idle_apply_answer failure 'another deadline apply held its lock for 400 ms'
      return
    fi
    oa_idle_apply_started=$(oa_idle_now)
    while :; do
      if ! oa_idle_apply_once; then
        oa_idle_apply_answer failure "$(head -c 400 "$OA_IDLE_WORK/apply-failure" | tr '\n' ' ')"
        return
      fi
      oa_idle_apply_applied=$oa_idle_apply_target
      oa_idle_recompute keep keep || break
      oa_idle_apply_moved=$(/usr/bin/jq -r '.deadline // 0' "$OA_IDLE_WORK/computed.json")
      test "$oa_idle_apply_moved" != "$oa_idle_apply_applied" || break
      test "$(($(oa_idle_now) - oa_idle_apply_started))" -le 800 || break
    done
    if test "$oa_idle_apply_applied" -le "$(oa_idle_now)"; then
      oa_idle_apply_answer result released
    else
      oa_idle_apply_answer result "$(/usr/bin/jq -nr --argjson at "$oa_idle_apply_applied" "$OA_IDLE_JQ_DEFS"'$at | iso')"
    fi
  } 8>>"$OA_IDLE_SHARED/.apply.lock"
}

# prints a deadline apply's adapter result
# arguments: result or failure, its text
oa_idle_apply_answer() {
  /usr/bin/jq -nc --argjson now "$(oa_idle_now)" --arg field "$1" --arg value "$2" "$OA_IDLE_JQ_DEFS"'
    {at: ($now | iso), action: "apply-deadline", ($field): ($value | text)}'
}

# hands the current deadline to the native-deadline adapter, as the agent
# even for a root event, and keeps its result in adapter.json; an apply that
# ends without an answer records that
oa_idle_dispatch() {
  : >"$OA_IDLE_WORK/answer"
  if test "$oa_idle_uid" -eq 0; then
    runuser -u "$OA_IDLE_AGENT" -- timeout -k 0.3 2.2 /bin/sh "$oa_idle_self" apply \
      >"$OA_IDLE_WORK/answer" 2>/dev/null </dev/null
  else
    timeout -k 0.1 2.5 /bin/sh "$oa_idle_self" apply >"$OA_IDLE_WORK/answer" 2>/dev/null </dev/null
  fi
  if ! /usr/bin/jq -ce "$OA_IDLE_JQ_DEFS"'select(isadapter and .action == "apply-deadline")' \
    "$OA_IDLE_WORK/answer" >"$OA_IDLE_WORK/adapter.json" 2>/dev/null; then
    oa_idle_apply_answer failure 'the apply was ended before the adapter answered' >"$OA_IDLE_WORK/adapter.json"
  fi
}

# reads the hook's JSON input for its session id, within a quarter of the
# budget and at most 1.5 seconds; it prints why the input is refused
# arguments: the budget in milliseconds
oa_idle_hook_session() {
  oa_idle_hook_session_wait=$(($1 / 4))
  test "$oa_idle_hook_session_wait" -le "$OA_IDLE_INPUT_WAIT_MS" || oa_idle_hook_session_wait=$OA_IDLE_INPUT_WAIT_MS
  oa_idle_hook_session_status=0
  timeout "$((oa_idle_hook_session_wait / 1000)).$(printf '%03d' "$((oa_idle_hook_session_wait % 1000))")" \
    head -c "$((OA_IDLE_INPUT_BYTES + 1))" >"$OA_IDLE_WORK/input" || oa_idle_hook_session_status=$?
  if test "$oa_idle_hook_session_status" -ne 0; then
    echo "hook input did not arrive within $oa_idle_hook_session_wait ms"
    return 1
  fi
  if test "$(wc -c <"$OA_IDLE_WORK/input")" -gt "$OA_IDLE_INPUT_BYTES"; then
    echo "hook input is larger than $OA_IDLE_INPUT_BYTES bytes"
    return 1
  fi
  if ! /usr/bin/jq -e . "$OA_IDLE_WORK/input" >/dev/null 2>&1; then
    echo 'hook input is not JSON'
    return 1
  fi
  if ! /usr/bin/jq -se 'length == 1 and (.[0] | type == "object" and (.session_id | type == "string"))' \
    "$OA_IDLE_WORK/input" >/dev/null 2>&1; then
    echo 'hook input has no session_id string'
    return 1
  fi
  if ! oa_idle_session=$(/usr/bin/jq -er '.session_id | select(test("\\A[A-Za-z0-9._:-]{1,128}\\z"))' \
    "$OA_IDLE_WORK/input" 2>/dev/null); then
    echo 'hook session_id must be 1 to 128 letters, digits or ._:- characters'
    return 1
  fi
}

# parses an awake event's options into oa_idle_source, oa_idle_session and
# oa_idle_pid, reading the hook input for the session `-`; it prints why
# the event is refused
# arguments: the options
oa_idle_parse() {
  oa_idle_source=
  oa_idle_session=
  oa_idle_pid=
  oa_idle_budget=$OA_IDLE_DEFAULT_BUDGET_MS
  while test "$#" -gt 0; do
    case $1 in
    --source | --session | --budget-ms | --pid)
      if test "$#" -lt 2; then
        echo "$1 needs a value"
        return 1
      fi
      case $1 in
      --source) oa_idle_source=$2 ;;
      --session) oa_idle_session=$2 ;;
      --budget-ms) oa_idle_budget=$2 ;;
      --pid) oa_idle_pid=$2 ;;
      esac
      shift 2
      ;;
    *)
      echo "unexpected option $(printf '%s' "$1" | head -c 32 | tr '[:cntrl:]' ' ')"
      return 1
      ;;
    esac
  done
  case $oa_idle_budget in '' | *[!0-9]* | 0?*) oa_idle_budget=0 ;; esac
  if test "${#oa_idle_budget}" -gt 4 || test "$oa_idle_budget" -lt "$OA_IDLE_MIN_BUDGET_MS" ||
    test "$oa_idle_budget" -gt "$OA_IDLE_DEFAULT_BUDGET_MS"; then
    echo '--budget-ms must be 1000 to 8000 milliseconds'
    return 1
  fi
  case $oa_idle_source in
  '' | [!a-z]* | *[!a-z0-9-]*) oa_idle_source= ;;
  esac
  if test -z "$oa_idle_source" || test "${#oa_idle_source}" -gt 32; then
    echo '--source must be a short lower-case name'
    return 1
  fi
  if test "$oa_idle_session" = -; then
    oa_idle_hook_session "$oa_idle_budget" || return 1
  else
    case $oa_idle_session in '' | *[!A-Za-z0-9._:-]*) oa_idle_session= ;; esac
    if test -z "$oa_idle_session" || test "${#oa_idle_session}" -gt 128; then
      echo '--session must be - or 1 to 128 letters, digits or ._:- characters'
      return 1
    fi
  fi
  oa_idle_pid_start=
  if test -n "$oa_idle_pid"; then
    if test "$oa_idle_uid" -ne 0; then
      echo '--pid is root'"'"'s alone'
      return 1
    fi
    if ! oa_idle_pid_start=$(oa_idle_process_start "$oa_idle_pid"); then
      echo '--pid must name a running process'
      return 1
    fi
  fi
}

# records one awake event, then hands a native-deadline provider the new
# deadline and records its result with the event's failure, if any
# arguments: the action, then its options
oa_idle_event() {
  oa_idle_action=$1
  shift
  if ! oa_idle_parse "$@" >"$OA_IDLE_WORK/refusal"; then
    oa_idle_action=
    printf 'refused an awake event: %s\n' "$(head -n 1 "$OA_IDLE_WORK/refusal")" >>"$OA_IDLE_WORK/notes"
    oa_idle_record
    return 0
  fi
  oa_idle_record || return 0
  if test "$(oa_idle_setting .provider.keepAwakeMode)" != native-deadline ||
    test -z "$(oa_idle_setting .provider.awakeAdapter)"; then
    return 0
  fi
  oa_idle_dispatch
  : >"$OA_IDLE_WORK/notes"
  oa_idle_record
}

# prints the recorded governor state for the host as a report, which says
# why when none is recorded or none is a governor state: the newer of the
# states root and the agent recorded, each having seen both accounts'
# holders, with the newer of their adapter results. The agent's is read as
# untrusted data and only printed
oa_idle_report() {
  oa_idle_read_state "$OA_IDLE_MANAGED" 0 root-state.json
  oa_idle_read_state "$OA_IDLE_SHARED" "$oa_idle_agent_uid" agent-state.json
  /usr/bin/jq -nc --slurpfile states "$OA_IDLE_WORK/root-state.json" \
    --slurpfile agent "$OA_IDLE_WORK/agent-state.json" "$OA_IDLE_JQ_DEFS"'
    def ishold: type == "object"
      and (.source | type == "string" and test("\\A[a-z][a-z0-9-]{0,31}\\z"))
      and (.session | type == "string" and test("\\A[0-9a-f]{64}\\z"))
      and (.expiresAt | isinstant);
    def isstate: .version == 1 and (.updatedAt | isinstant)
      and ((has("keepAwakeMode") | not) or (.keepAwakeMode | IN("native-deadline", "governed", "none")))
      and (.idleTimeoutMinutes | count) and (.holdMaxMinutes | count)
      and ((has("lastHeartbeat") | not) or (.lastHeartbeat | isinstant))
      and (.holds | type == "array" and length <= 32 and all(.[]; ishold))
      and (.openHolds | count) and .openHolds >= (.holds | length)
      and ((has("deadline") | not) or (.deadline | isinstant))
      and (.sleepPermitted | type == "boolean")
      and ((has("adapter") | not) or (.adapter | isadapter))
      and (.diagnostics | type == "array" and length <= 8 and all(.[]; istext));
    ($states + $agent) as $recorded
    | [$recorded[] | select(isstate)] as $valid
    | if ($recorded | length) == 0 then {recorded: false, reason: "no governor state is recorded"}
      elif ($valid | length) == 0 then {recorded: false, reason: "the recorded governor state is not valid"}
      else
        ([$valid[] | .adapter // empty] | max_by(.at | instant)) as $adapter
        | {recorded: true, state: (($valid | max_by(.updatedAt | instant))
            + (if $adapter != null then {adapter: $adapter} else {} end))}
      end'
}

# makes the directories the governor keeps its state in: the run directory,
# root's, the shared awake directory, which the agent writes and root only
# reads, sticky so no account removes or renames another's entry, and the
# managed one, which the agent only reads, and the governor lock, which the
# agent only opens to read and lock; it fails when one is a link. The
# five-digit modes clear a set-group-id bit an earlier mode left
oa_idle_install() {
  for oa_idle_install_spec in "$OA_IDLE_RUN root 00755" "$OA_IDLE_SHARED $OA_IDLE_AGENT 01770" \
    "$OA_IDLE_MANAGED $OA_IDLE_AGENT 02750"; do
    oa_idle_install_mode=${oa_idle_install_spec##* }
    oa_idle_install_group=${oa_idle_install_spec% *}
    oa_idle_install_group=${oa_idle_install_group##* }
    oa_idle_install_path=${oa_idle_install_spec%% *}
    if test -L "$oa_idle_install_path"; then
      echo "Refusing $oa_idle_install_path: it is a link" >&2
      return 1
    fi
    mkdir -p "$oa_idle_install_path" &&
      chown "root:$oa_idle_install_group" "$oa_idle_install_path" &&
      chmod "$oa_idle_install_mode" "$oa_idle_install_path" || return 1
  done
  if test -L "$OA_IDLE_LOCK"; then
    echo "Refusing $OA_IDLE_LOCK: it is a link" >&2
    return 1
  fi
  touch "$OA_IDLE_LOCK" && chown "root:$OA_IDLE_AGENT" "$OA_IDLE_LOCK" && chmod 0640 "$OA_IDLE_LOCK"
}

# tells whether the governor's directories and lock are in place with their
# owners and modes
oa_idle_check() {
  test "$(stat -c '%F %U:%G %a' "$OA_IDLE_RUN" "$OA_IDLE_SHARED" "$OA_IDLE_MANAGED" "$OA_IDLE_LOCK" 2>/dev/null)" = \
    "directory root:root 755
directory root:$OA_IDLE_AGENT 1770
directory root:$OA_IDLE_AGENT 2750
regular empty file root:$OA_IDLE_AGENT 640"
}

# runs a subcommand with a work directory of its own, removed on exit
# arguments: the subcommand and its arguments
oa_idle_main() {
  oa_idle_uid=$(id -u)
  oa_idle_agent_uid=$(id -u "$OA_IDLE_AGENT" 2>/dev/null) || oa_idle_agent_uid=none
  oa_idle_own=$OA_IDLE_SHARED
  oa_idle_as_root=false
  if test "$oa_idle_uid" -eq 0; then
    oa_idle_own=$OA_IDLE_MANAGED
    oa_idle_as_root=true
  fi
  oa_idle_action=
  oa_idle_event_failure=
  oa_idle_idle_form_in_flight=
  OA_IDLE_WORK=$(mktemp -d) || exit 1
  trap 'rm -rf "$OA_IDLE_WORK"' EXIT
  trap 'exit 143' HUP INT TERM
  : >"$OA_IDLE_WORK/notes"
  oa_idle_main_command=$1
  shift
  case $oa_idle_main_command in
  heartbeat | hold-open | hold-close) oa_idle_event "$oa_idle_main_command" "$@" ;;
  apply) oa_idle_apply ;;
  tick | report | install | check)
    if test "$oa_idle_uid" -ne 0; then
      echo "open-agent-awake $oa_idle_main_command is root's alone" >&2
      exit 77
    fi
    "oa_idle_$oa_idle_main_command"
    ;;
  esac
}

oa_idle_self=$0
case ${1-} in
heartbeat | hold-open | hold-close)
  if test -n "${OA_AWAKE_CHILD-}"; then
    oa_idle_main "$@"
    exit 0
  fi
  # the event runs in a child bounded by its budget, which never answers
  # its caller with anything but success
  oa_idle_budget=$OA_IDLE_DEFAULT_BUDGET_MS
  oa_idle_previous=
  for oa_idle_argument in "$@"; do
    if test "$oa_idle_previous" = --budget-ms; then
      case $oa_idle_argument in
      [1-8][0-9][0-9][0-9]) test "$oa_idle_argument" -gt 8000 || oa_idle_budget=$oa_idle_argument ;;
      esac
    fi
    oa_idle_previous=$oa_idle_argument
  done
  OA_AWAKE_CHILD=1 timeout -k 0.2 \
    "$((oa_idle_budget / 1000)).$(printf '%03d' "$((oa_idle_budget % 1000))")" \
    /bin/sh "$oa_idle_self" "$@" >/dev/null 2>&1
  exit 0
  ;;
apply | tick | report | install | check)
  oa_idle_main "$@"
  ;;
*)
  echo "$OA_IDLE_USAGE" >&2
  exit 64
  ;;
esac
