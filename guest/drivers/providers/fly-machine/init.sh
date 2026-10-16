#!/bin/sh
# open-agent's Fly Machine boot stub: the machine's init, which the machine
# configuration writes to the root filesystem on every boot. It checks that
# the volume and its guest root are root's alone and binds the guest root,
# then runs the boot hook setup keeps on the volume, named by its one
# argument, only while the hook and every directory above it are root's
# alone. Until then, and after a hook that exited unexpectedly until setup
# replaces it, it reports the boot ready so setup can reach the machine to
# repair it. The hook replaces itself with runsvdir, to which the stub hands
# a stop as a hangup, so runit stops every service; the stub then waits for
# every runsv and its service to exit, short of the machine's stop timeout,
# kills what remains, flushes the volume and exits. A boot whose volume or
# hook halts waits ten minutes, for someone to read the log, then stops the
# machine through the guest-local Machines API, postponing the stop while a
# setup session is open. A hook that halted with the guest root on the volume
# leaves the guest for setup to repair: once setup's prepare marks the boot
# resumed, the stub runs the hook again. It uses the image's own tools alone

set -u
umask 022
PATH=$OA_SYSTEM_PATH
LC_ALL=C
export PATH LC_ALL

OA_VOLUME=/data
OA_VOLUME_ROOT=$OA_VOLUME/open-agent
OA_RUN=/run/open-agent
OA_READY=$OA_RUN/boot-ready
OA_FLY_API=/.fly/api
# the lock a setup session holds while it runs
OA_SESSION_LOCK=$OA_SESSION_DIRECTORY/session.lock
# how long a halted boot waits before it stops the machine, and its stop
# request may take
OA_HALT_SECONDS=600
OA_STOP_SECONDS=30
# how often the stub looks for a hook it may run
OA_POLL_SECONDS=5
# how long a stop waits for runit's services, short of the 30 seconds the
# machine configuration gives a stop before Fly kills the machine
OA_SHUTDOWN_SECONDS=20
# the exit of a hook a critical step halted
OA_HALTED=3

# writes one line to the console, which Fly keeps as the machine's log
# arguments: the message
oa_log() {
  printf 'open-agent-boot %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# tells whether a directory is root's alone: a real directory root owns that
# no group or other account can write
# arguments: the directory
oa_root_only() {
  test -d "$1" && ! test -L "$1" &&
    test "$(stat -c %u "$1")" = 0 &&
    test $((0$(stat -c %a "$1") & 022)) -eq 0
}

# tells whether root may run a file: a regular file root's alone, as is every
# directory above it
# arguments: the file
oa_trusted() {
  test -f "$1" && ! test -L "$1" || return 1
  test "$(stat -c %u "$1")" = 0 || return 1
  test $((0$(stat -c %a "$1") & 022)) -eq 0 || return 1
  oa_trusted_directory=${1%/*}
  while test -n "$oa_trusted_directory"; do
    oa_root_only "$oa_trusted_directory" || return 1
    oa_trusted_directory=${oa_trusted_directory%/*}
  done
  oa_root_only /
}

# writes the ready file the host waits for, naming this boot
# arguments: ok, or failed when the volume or its guest root is unusable
oa_ready() {
  printf '%s %s\n' "$oa_boot_id" "$1" >"$OA_READY.new" && mv -f "$OA_READY.new" "$OA_READY"
}

# checks the volume and its guest root and binds the guest root over its root
# filesystem path, once per boot
oa_volume() {
  if ! mountpoint -q "$OA_VOLUME"; then
    oa_log "no volume is mounted at $OA_VOLUME"
    return 1
  fi
  if ! oa_root_only "$OA_VOLUME"; then
    oa_log "$OA_VOLUME is not root's alone"
    return 1
  fi
  if ! test -e "$OA_VOLUME_ROOT"; then
    install -d -m 0755 "$OA_VOLUME_ROOT" || return 1
  fi
  if ! oa_root_only "$OA_VOLUME_ROOT"; then
    oa_log "$OA_VOLUME_ROOT is not root's alone"
    return 1
  fi
  if test "$(stat -c '%d %i' "$OA_VOLUME_ROOT")" = "$(stat -c '%d %i' "$OA_GUEST_ROOT" 2>/dev/null)"; then
    return 0
  fi
  if mountpoint -q "$OA_GUEST_ROOT"; then
    oa_log "something other than $OA_VOLUME_ROOT is mounted at $OA_GUEST_ROOT"
    return 1
  fi
  mkdir -p "$OA_GUEST_ROOT" && mount --bind "$OA_VOLUME_ROOT" "$OA_GUEST_ROOT"
}

# asks the Machines API, through the guest-local socket, to stop this machine;
# succeeds only when the API answers with a 2xx status. The image has no curl,
# so Perl, which its base packages always include, writes the request
oa_stop_machine() {
  perl -e '
    use strict;
    use warnings;
    use Socket;
    my ($socket_path, $app, $machine, $seconds) = @ARGV;
    die "FLY_APP_NAME and FLY_MACHINE_ID name no machine\n"
      unless $app =~ /^[a-z0-9][a-z0-9-]{0,62}$/ && $machine =~ /^[a-z0-9]{1,32}$/;
    local $SIG{ALRM} = sub { die "the Machines API did not answer in time\n" };
    alarm $seconds;
    socket(my $api, PF_UNIX, SOCK_STREAM, 0) or die "socket: $!\n";
    connect($api, sockaddr_un($socket_path)) or die "connect: $!\n";
    my $request = "POST /v1/apps/$app/machines/$machine/stop HTTP/1.0\r\nHost: flaps\r\nContent-Length: 0\r\n\r\n";
    syswrite($api, $request) == length($request) or die "write: $!\n";
    my $status = <$api>;
    defined $status or die "the Machines API closed without an answer\n";
    $status =~ s/\s+$//;
    print "stop answered: $status\n";
    exit($status =~ m{^HTTP/1\.[01] 2[0-9][0-9]\b} ? 0 : 1);
  ' "$OA_FLY_API" "${FLY_APP_NAME:-}" "${FLY_MACHINE_ID:-}" "$OA_STOP_SECONDS"
}

# tells whether a setup session holds its lock
oa_repairing() {
  test -f "$OA_SESSION_LOCK" && ! flock -n "$OA_SESSION_LOCK" true
}

# waits, then stops the machine, again and again until it stops: the init
# never exits, so an idle machine would otherwise run, and bill, for ever. A
# halt setup may repair returns once setup's prepare marks the boot resumed
# arguments: repairable, when setup may repair the guest
oa_halt() {
  trap oa_exit INT TERM HUP
  oa_log "halt=waiting $OA_HALT_SECONDS seconds, then stopping the machine"
  oa_halt_at=$(($(date +%s) + OA_HALT_SECONDS))
  while :; do
    sleep "$OA_POLL_SECONDS" &
    wait $!
    if test "${1-}" = repairable && test "$(cat "$OA_READY" 2>/dev/null)" = "$oa_boot_id resumed"; then
      oa_log "halt=resumed: setup repaired the guest"
      return 0
    fi
    test "$(date +%s)" -ge "$oa_halt_at" || continue
    oa_halt_at=$(($(date +%s) + OA_HALT_SECONDS))
    if oa_repairing; then
      oa_log "halt=stop postponed $OA_HALT_SECONDS seconds: a setup session is open"
    elif oa_stop_machine; then
      oa_log "halt=stop requested"
    else
      oa_log "halt=stop failed; retrying after $OA_HALT_SECONDS seconds"
    fi
  done
}

# flushes the volume and exits, on a stop that finds no service running
oa_exit() {
  sync
  exit 0
}

# reads a process's session into oa_session, from the fields of its stat
# after the command name, which may itself hold spaces and parentheses
# arguments: the process's /proc directory
oa_session_of() {
  oa_stat=$(cat "$1/stat" 2>/dev/null) || return 1
  read -r _ _ _ oa_session _ <<EOF
${oa_stat##*) }
EOF
  test -n "$oa_session"
}

# lists the sessions runsv leads: runsvdir -P starts each runsv as a session
# leader, so a session holds a runsv and the service it runs
oa_runit_sessions() {
  for oa_proc in /proc/[0-9]*; do
    oa_comm=$(cat "$oa_proc/comm" 2>/dev/null) || continue
    test "$oa_comm" = runsv || continue
    oa_session_of "$oa_proc" && printf ' %s' "$oa_session"
  done
}

# lists the processes left in the sessions given, one a line
# arguments: the sessions, each preceded by a space
oa_session_members() {
  for oa_proc in /proc/[0-9]*; do
    oa_session_of "$oa_proc" || continue
    case "$1 " in
      *" $oa_session "*) echo "${oa_proc#/proc/}" ;;
    esac
  done
}

# hands a stop to the hook, or to the runsvdir it became, as a hangup, on
# which runsvdir stops every runsv, and each runsv its service; the sessions
# runsv leads are noted first, while runsvdir still supervises them
oa_forward() {
  oa_stopping=1
  oa_sessions=$(oa_runit_sessions)
  kill -HUP "$oa_child" 2>/dev/null || :
}

# waits for every process in runit's sessions to exit, kills those left at
# the deadline, flushes the volume and exits
oa_shutdown() {
  oa_deadline=$(($(date +%s) + OA_SHUTDOWN_SECONDS))
  while oa_left=$(oa_session_members "$oa_sessions") && test -n "$oa_left"; do
    if test "$(date +%s)" -ge "$oa_deadline"; then
      oa_log "stop: killing the $(echo "$oa_left" | wc -l) processes runit left after $OA_SHUTDOWN_SECONDS seconds"
      echo "$oa_left" | while read -r oa_pid; do
        kill -KILL "$oa_pid" 2>/dev/null || :
      done
      break
    fi
    sleep 1
  done
  oa_log "stop: flushing the volume"
  oa_exit
}

# runs the hook and waits for it to exit, forwarding a stop
oa_run() {
  oa_stopping=
  /bin/sh "$oa_hook" boot </dev/null &
  oa_child=$!
  trap oa_forward INT TERM HUP
  while :; do
    wait "$oa_child"
    oa_status=$?
    kill -0 "$oa_child" 2>/dev/null || break
  done
  trap oa_exit INT TERM HUP
  return "$oa_status"
}

oa_hook=${1-}
case $oa_hook in
  "$OA_VOLUME_ROOT"/*.sh) ;;
  *)
    oa_log "the boot stub needs the boot hook's path under $OA_VOLUME_ROOT"
    exit 1
    ;;
esac
case $oa_hook in
  */../* | */./*)
    oa_log "refusing the boot hook path $oa_hook"
    exit 1
    ;;
esac

trap oa_exit INT TERM HUP
install -d -m 0755 "$OA_RUN"
oa_boot_id=$(cat /proc/sys/kernel/random/boot_id)
oa_log "boot id=$oa_boot_id stub started"
if ! oa_volume; then
  oa_ready failed
  oa_halt
fi

# the hook last run, so one that exited unexpectedly runs again only once
# setup has replaced it
oa_ran=
oa_waiting=
while :; do
  if oa_trusted "$oa_hook" && oa_sum=$(cksum <"$oa_hook") && test "$oa_sum" != "$oa_ran"; then
    oa_ran=$oa_sum
    oa_waiting=
    oa_log "handover=boot hook"
    oa_run
    oa_status=$?
    if test -n "$oa_stopping"; then
      oa_shutdown
    fi
    if test "$oa_status" = "$OA_HALTED"; then
      oa_log "handover=none: a critical step of the boot hook failed; see $OA_GUEST_ROOT/boot.log"
      if test "$(cat "$OA_READY" 2>/dev/null)" = "$oa_boot_id halted"; then
        oa_halt repairable
        # setup repaired the guest, so the hook runs again, changed or not
        oa_ran=
        continue
      fi
      oa_halt
    fi
    oa_log "the boot hook exited with status $oa_status; waiting for setup to replace it"
    oa_ready ok
  elif test -z "$oa_waiting" && test -z "$oa_ran"; then
    oa_waiting=1
    if test -e "$oa_hook"; then
      oa_log "refusing $oa_hook: it or a directory above it is not root's alone; waiting for setup to replace it"
    else
      oa_log "no boot hook at $oa_hook yet; waiting for setup to install it"
    fi
    oa_ready ok
  fi
  sleep "$OA_POLL_SECONDS" &
  wait $!
done
