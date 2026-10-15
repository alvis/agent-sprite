#!/bin/sh
# lets one update check through per interval: cron starts this gate every
# minute, and it costs one shell, so Node starts only when a check is due.
# Exits 0 and records the minute when a check is due, and 1 when it is not.
# Callers hold the update lock, which serialises the stamp with the updater.
set -eu

export PATH=/usr/sbin:/usr/bin:/sbin:/bin

# the files and the interval limits come from src/guest/update-schedule.ts,
# which this shell cannot import
schedule="${1:?schedule file required}"
stamp="${2:?stamp file required}"
fallback="${3:?fallback minutes required}"
maximum="${4:?maximum minutes required}"

umask 077

every=$(cat "$schedule" 2>/dev/null || true)
valid=0
case "$every" in
  # empty, not a plain whole number, with a leading zero (which includes zero),
  # or ten digits or more, which shell arithmetic would not compare safely
  '' | *[!0-9]* | 0* | ??????????*) ;;
  *)
    if test "$every" -le "$maximum"; then
      valid=1
    fi
    ;;
esac
if test "$valid" -eq 0; then
  echo "update gate: no valid check interval from 1 to $maximum in $schedule; using $fallback minutes" >&2
  every=$fallback
fi

now=$(($(date +%s) / 60))
last=$(cat "$stamp" 2>/dev/null || true)
case "$last" in
  # a leading zero is not a number to dash arithmetic
  '' | *[!0-9]* | 0?* | ??????????*) last=-1 ;;
esac

# a stamp from the future (the clock moved back) is never a recent check
if test "$last" -ge 0 && test "$last" -le "$now" &&
  test $((now - last)) -lt "$every"; then
  exit 1
fi

printf '%s\n' "$now" >"$stamp.new"
mv -f "$stamp.new" "$stamp"
