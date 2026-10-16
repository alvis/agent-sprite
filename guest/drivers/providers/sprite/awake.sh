#!/bin/sh
# open-agent's Sprite awake adapter, run by the agent account alone: the
# idle governor runs `apply-deadline <epoch-ms>` for every new awake
# deadline, and the Sprite keeps itself awake while a task of open-agent's
# lives. A deadline still ahead refreshes the task to expire then, at most
# the hour a Sprite keeps a task; one already passed deletes it, so the
# Sprite may sleep. It exits 0 once the deadline is applied, and otherwise
# prints why not and exits 1

set -u
umask 077
PATH=$OA_SYSTEM_PATH
LC_ALL=C
export PATH LC_ALL

# the guest-local Sprite API socket, the host name it expects and the task
OA_SPRITE_SOCKET=/.sprite/api.sock
OA_SPRITE_TASK=http://sprite/v1/tasks/open-agent-awake
# seconds a request may take, within the governor's limit of one apply
OA_SPRITE_SECONDS=1.2
# longest a Sprite keeps a task, in seconds
OA_SPRITE_TASK_LIMIT=3600
# most bytes kept of an answer for a failure
OA_SPRITE_EXCERPT_BYTES=256

# sends one request about the task and prints the status, 000 when no answer came
# arguments: the method, then the JSON body, if any
oa_sprite_call() {
  if test "$#" -gt 1; then
    curl -sS --unix-socket "$OA_SPRITE_SOCKET" --max-time "$OA_SPRITE_SECONDS" -X "$1" \
      -H 'Content-Type: application/json' --data "$2" \
      -o "$oa_sprite_work/body" -w '%{http_code}' "$OA_SPRITE_TASK" 2>"$oa_sprite_work/error"
  else
    curl -sS --unix-socket "$OA_SPRITE_SOCKET" --max-time "$OA_SPRITE_SECONDS" -X "$1" \
      -o "$oa_sprite_work/body" -w '%{http_code}' "$OA_SPRITE_TASK" 2>"$oa_sprite_work/error"
  fi
}

# prints why the last request failed: the start of its answer, or the
# transport's reason when none came
# arguments: the request's name, its status
oa_sprite_problem() {
  if test "$2" = 000; then
    printf 'Sprite task %s got no answer: %s\n' "$1" \
      "$(head -c "$OA_SPRITE_EXCERPT_BYTES" "$oa_sprite_work/error" 2>/dev/null | tr '[:cntrl:]' ' ')"
  else
    printf 'Sprite task %s answered %s: %s\n' "$1" "$2" \
      "$(head -c "$OA_SPRITE_EXCERPT_BYTES" "$oa_sprite_work/body" 2>/dev/null | tr '[:cntrl:]' ' ')"
  fi
}

# applies one deadline: deletes the task once it passed, else refreshes it
# to expire then
# arguments: the deadline in epoch milliseconds, 0 to release
oa_sprite_apply_deadline() {
  case $1 in
  '' | *[!0-9]* | ????????????????*)
    echo "the deadline $1 is not epoch milliseconds"
    return 1
    ;;
  esac
  oa_sprite_apply_deadline_remaining=$(($1 - $(date +%s%3N)))
  if test "$oa_sprite_apply_deadline_remaining" -le 0; then
    oa_sprite_apply_deadline_status=$(oa_sprite_call DELETE)
    case $oa_sprite_apply_deadline_status in
    204 | 404) return 0 ;;
    esac
    oa_sprite_problem delete "$oa_sprite_apply_deadline_status"
    return 1
  fi
  oa_sprite_apply_deadline_seconds=$(((oa_sprite_apply_deadline_remaining + 999) / 1000))
  oa_sprite_apply_deadline_expire=$oa_sprite_apply_deadline_seconds
  if test "$oa_sprite_apply_deadline_expire" -gt "$OA_SPRITE_TASK_LIMIT"; then
    oa_sprite_apply_deadline_expire=$OA_SPRITE_TASK_LIMIT
  fi
  oa_sprite_apply_deadline_status=$(oa_sprite_call PUT "{\"expire\":$oa_sprite_apply_deadline_expire}")
  if test "$oa_sprite_apply_deadline_status" != 200; then
    oa_sprite_problem refresh "$oa_sprite_apply_deadline_status"
    return 1
  fi
  if test "$oa_sprite_apply_deadline_seconds" -gt "$OA_SPRITE_TASK_LIMIT"; then
    echo "the Sprite keeps a task at most $OA_SPRITE_TASK_LIMIT seconds; the deadline is $oa_sprite_apply_deadline_seconds seconds away"
    return 1
  fi
}

case ${1-} in
apply-deadline)
  oa_sprite_work=$(mktemp -d) || {
    echo 'the adapter could not make a work directory'
    exit 1
  }
  trap 'rm -rf "$oa_sprite_work"' EXIT
  trap 'exit 143' HUP INT TERM
  oa_sprite_apply_deadline "${2-}" || exit 1
  ;;
*)
  echo "usage: $OA_GUEST_ROOT/drivers/providers/sprite/awake.sh apply-deadline <epoch-ms>; a Sprite enters no idle form itself" >&2
  exit 64
  ;;
esac
