// the Fly Machine boot script: POSIX sh rendered from guest constants, so the
// paths it rebuilds are the very paths the installer uses

import { GUEST_ROOT } from '#guest/guest-root';
import { SUPERVISOR_COMMAND } from '#guest/supervisor/protocol';

import {
  BOOT_ID_FILE,
  BOOT_LOG,
  BOOT_READY_FILE,
  BOOT_RUN_DIRECTORY,
  BOOT_STATUS,
  FLY_API_SOCKET,
  HALTED_WAIT_SECONDS,
  LOG_KEPT_BYTES,
  LOG_LIMIT_BYTES,
  STOP_REQUEST_SECONDS,
  SUPERVISOR_POLL_SECONDS,
  VOLUME_LAYOUT,
  VOLUME_PATH,
} from './boot-paths.js';
import { aptSection, labelSection, linkSection } from './boot-restore.js';
import {
  accountSection,
  guardSection,
  homeSection,
  volumeSection,
} from './boot-volume.js';

/**
 * renders the boot script. On every boot, the first create's included, it
 * binds the volume's directories over the guest root, the agent's home and
 * the Homebrew home; recreates both accounts under the ids their homes were
 * made under, without changing any file's owner; reinstalls the packages
 * recorded on the volume from the volume's apt cache without `apt-get
 * update`; restores the links and the login profile the installer relies on, and the
 * machine label file from the workstation name recorded on the volume;
 * logs every step; then runs the guest supervisor from the volume, or waits
 * for it, whenever every critical step succeeded, even if an optional step
 * failed and the boot status says so. A boot a critical step halted waits a
 * while, then stops the machine through the guest-local Machines API. With the argument `record-packages`, apt runs it after every dpkg
 * call to record the packages installed since the boot began
 * @returns the script's text
 */
export function bootScript(): string {
  return `${[
    preambleSection(),
    stepSection(),
    guardSection(),
    volumeSection(),
    accountSection(),
    homeSection(),
    aptSection(),
    linkSection(),
    labelSection(),
    runSection(),
    handoverSection(),
  ].join('\n\n')}\n`;
}

/**
 * the script's environment, its package recorder, and the dispatch to it when apt runs the script after dpkg
 * @returns the section's text
 */
export function preambleSection(): string {
  return `#!/bin/sh
# open-agent boot script for a Fly Machine, rendered from
# src/drivers/providers/fly-machine/guest/. The machine runs it as root, as
# its init, from the root filesystem on every boot.
set -u
umask 022
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
# apt never asks a question at boot
export DEBIAN_FRONTEND=noninteractive

# the volume, this boot's state, and the logs and entry kept on the volume
volume=${VOLUME_PATH}
run_dir=${BOOT_RUN_DIRECTORY}
buffer=$run_dir/boot.log
baseline=$run_dir/image-packages
ready=${BOOT_READY_FILE}
record=${VOLUME_LAYOUT.packages}
boot_log=${BOOT_LOG}
boot_status=${BOOT_STATUS}
supervisor=${SUPERVISOR_COMMAND}
fly_api=${FLY_API_SOCKET}
halted_wait=${HALTED_WAIT_SECONDS}

# lists the packages dpkg has installed, one name per line, sorted
installed_packages() {
  dpkg-query -W -f='\${db:Status-Abbrev} \${Package}\\n' | awk '$1 == "ii" { print $2 }' | sort -u
}

# adds to the volume's record every package installed since this boot began,
# so the next cold boot installs it again; the image's own packages stay out,
# and a package stays recorded even when a boot fails to reinstall it
record_packages() {
  test -f "$baseline" || return 0
  mountpoint -q "$volume" || return 0
  installed_packages | comm -23 - "$baseline" >"$run_dir/added" || return 1
  touch "$record" || return 1
  sort -u "$record" "$run_dir/added" >"$record.new" || return 1
  mv -f "$record.new" "$record"
}

if test "$#" -gt 0 && test "$1" = record-packages; then
  record_packages
  exit 0
fi`;
}

/**
 * the boot's logging and the step runner every step goes through
 * @returns the section's text
 */
export function stepSection(): string {
  return `mkdir -p "$run_dir"
chmod 0755 "$run_dir"
rm -f "$ready"
: >"$buffer"
chmod 0600 "$buffer"
sink=$buffer
boot_id=$(cat ${BOOT_ID_FILE})
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
boot_began=$(date +%s%3N)
halted=0
failed=0
steps=

# writes one line to the log and to the console, which Fly keeps as the
# machine's log
log() {
  line="open-agent-boot $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\\n' "$line" >>"$sink"
  printf '%s\\n' "$line"
}

# runs one step with its output in the log, then logs its outcome and
# duration; a failed critical step skips every later step, since those would
# otherwise write the volume's data onto the root filesystem. Each step runs in
# a subshell, so a step's variables never overwrite the runner's
step() {
  name=$1
  critical=$2
  shift 2
  if test "$halted" = 1; then
    log "step=$name outcome=skipped"
    steps="$steps\${steps:+,}\\"$name\\":{\\"outcome\\":\\"skipped\\",\\"durationMs\\":0}"
    return 0
  fi
  begun=$(date +%s%3N)
  if ("$@") >>"$sink" 2>&1; then
    outcome=ok
  else
    outcome=failed
    failed=1
    if test "$critical" = critical; then
      halted=1
    fi
  fi
  took=$(($(date +%s%3N) - begun))
  log "step=$name outcome=$outcome duration_ms=$took"
  steps="$steps\${steps:+,}\\"$name\\":{\\"outcome\\":\\"$outcome\\",\\"durationMs\\":$took}"
}`;
}

/**
 * runs every step in order, then writes the log, the status and the ready file
 * @returns the section's text
 */
export function runSection(): string {
  return `log "boot id=$boot_id started"
if ! test -f "$baseline"; then
  installed_packages >"$baseline.new" && mv -f "$baseline.new" "$baseline"
fi
step volume critical check_volume
step guest-root critical mount_guest_root
step agent-account critical restore_agent
step homebrew-account critical restore_homebrew
step apt-cache optional configure_apt
step packages optional install_packages
step links optional restore_links
step profile optional write_profile
step label optional restore_label

status=ok
if test "$failed" = 1; then
  status=failed
fi
took=$(($(date +%s%3N) - boot_began))
log "boot status=$status duration_ms=$took"
# the log and the status reach the volume only once the guest root is bound
if mountpoint -q ${GUEST_ROOT}; then
  if ! test -e "$boot_log"; then
    install -m 0600 /dev/null "$boot_log"
  fi
  cat "$buffer" >>"$boot_log"
  if test "$(stat -c %s "$boot_log")" -gt ${LOG_LIMIT_BYTES}; then
    tail -c ${LOG_KEPT_BYTES} "$boot_log" >"$boot_log.new" && mv -f "$boot_log.new" "$boot_log"
  fi
  sink=$boot_log
  printf '{"bootId":"%s","startedAt":"%s","status":"%s","durationMs":%s,"steps":{%s}}\\n' \\
    "$boot_id" "$started_at" "$status" "$took" "$steps" >"$boot_status.new"
  chmod 0644 "$boot_status.new"
  mv -f "$boot_status.new" "$boot_status"
fi
printf '%s %s\\n' "$boot_id" "$status" >"$ready.new"
mv -f "$ready.new" "$ready"`;
}

/**
 * the request that stops this machine through the guest-local Machines API.
 * The stock image has no curl, so Perl, which the image's base packages always
 * include, writes the request to the socket
 * @returns the section's text
 */
export function stopSection(): string {
  return `# asks the Machines API, through the guest-local socket, to stop this machine;
# succeeds only when the API answers with a 2xx status
stop_machine() {
  perl -e '
    use strict;
    use warnings;
    use Socket;
    my ($socket_path, $app, $machine) = @ARGV;
    die "FLY_APP_NAME and FLY_MACHINE_ID name no machine\\n"
      unless $app =~ /^[a-z0-9][a-z0-9-]{0,62}$/ && $machine =~ /^[a-z0-9]{1,32}$/;
    local $SIG{ALRM} = sub { die "the Machines API did not answer in time\\n" };
    alarm ${STOP_REQUEST_SECONDS};
    socket(my $api, PF_UNIX, SOCK_STREAM, 0) or die "socket: $!\\n";
    connect($api, sockaddr_un($socket_path)) or die "connect: $!\\n";
    my $request = "POST /v1/apps/$app/machines/$machine/stop HTTP/1.0\\r\\nHost: flaps\\r\\nContent-Length: 0\\r\\n\\r\\n";
    syswrite($api, $request) == length($request) or die "write: $!\\n";
    my $status = <$api>;
    defined $status or die "the Machines API closed without an answer\\n";
    $status =~ s/\\s+$//;
    print "stop answered: $status\\n";
    exit($status =~ m{^HTTP/1\\.[01] 2[0-9][0-9]\\b} ? 0 : 1);
  ' "$fly_api" "\${FLY_APP_NAME:-}" "\${FLY_MACHINE_ID:-}" >>"$sink" 2>&1
}`;
}

/**
 * hands the machine over to the guest supervisor once it exists on the volume, or waits, whenever no critical step halted the boot; a boot a critical step halted waits a bounded time and stops the machine, since the init never exits and an idle machine would run, and bill, for ever
 * @returns the section's text
 */
export function handoverSection(): string {
  return `${stopSection()}

# the machine stops when its init exits, so this process either becomes the
# supervisor or waits. An optional step that failed leaves the status failed,
# for doctor, and does not keep the supervisor from starting; only a halt does
trap 'exit 0' INT TERM
if test "$halted" = 0; then
  waiting=0
  while :; do
    if is_trusted_entry "$supervisor"; then
      log "handover=supervisor"
      exec "$supervisor"
    fi
    if test "$waiting" = 0; then
      log "handover=waiting for $supervisor"
      waiting=1
    fi
    sleep ${SUPERVISOR_POLL_SECONDS} &
    wait $!
  done
fi
log "handover=none: a critical step failed; see $sink"
log "halt=waiting $halted_wait seconds, then stopping the machine"
while :; do
  sleep "$halted_wait" &
  wait $!
  if stop_machine; then
    log "halt=stop requested"
  else
    log "halt=stop failed; retrying after $halted_wait seconds"
  fi
done`;
}
