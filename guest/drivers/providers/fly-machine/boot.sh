#!/bin/sh
# open-agent's Fly Machine boot hook, kept on the volume and run as root: by
# the boot stub on every boot (`boot`), and by setup, which installs it
# (`prepare`). It binds the volume's guest root, homes and apt lists over the
# root filesystem, recreates the agent's and Homebrew's accounts under the
# ids their homes on the volume were made under, so no file changes owner,
# and keeps apt's downloads in the volume's cache. On a root filesystem it
# has not restored yet, which a marker on that filesystem tells, it
# reinstalls the recorded packages from that cache alone, with their
# repositories, and puts back the services and jobs environment.json
# records; on every run it restores the tools' links, the login profile, the
# machine label and ping's group range. Every run logs its steps to
# boot.log; a boot also writes boot-status.json and the ready file, then
# replaces itself with runsvdir once runit is installed, while a boot a
# critical step halted exits 3 for the stub to stop the machine, unless a
# prepare repairs the guest first: the ready file then says `resumed`, and
# the stub runs the boot again. `check` tells whether a prepare would change
# nothing setup needs, which a halted boot never allows, and apt runs
# `record-packages` after every dpkg call to record each package installed
# beyond the image's own. Until the packages are back it runs the image's
# tools and the volume's alone, and it calls a guest library only once the
# library is root's alone

set -u
umask 022
PATH=$OA_SYSTEM_PATH
LC_ALL=C
DEBIAN_FRONTEND=noninteractive
export PATH LC_ALL DEBIAN_FRONTEND

# the volume, the directories it keeps and its record of every package
# installed beyond the image's, the root filesystem's own record, and this
# boot's state come in the header as the OA_FLY_* variables
# what setup keeps in the guest root, which the volume's is bound over
OA_BOOT_SELF=$OA_GUEST_ROOT/drivers/providers/fly-machine/boot.sh
OA_BOOT_FAMILY=$OA_GUEST_ROOT/os/debian/lib.sh
OA_BOOT_LINKS=$OA_GUEST_ROOT/tools/links.sh
OA_BOOT_RUNIT=$OA_GUEST_ROOT/services/runit/lib.sh
OA_BOOT_CRON=$OA_GUEST_ROOT/services/cron.sh
# the image's packages, beside the marker a restore leaves once the
# packages, services and jobs are back
OA_BOOT_BASELINE=$OA_FLY_ROOTFS_STATE/image-packages
OA_BOOT_LOCK=$OA_FLY_RUN/boot.lock
# seconds a run waits for another to finish, such as a boot for setup's prepare
OA_BOOT_LOCK_WAIT=600
# the root filesystem files the hook writes
OA_BOOT_APT_CONFIG=/etc/apt/apt.conf.d/90open-agent
# the image's apt hook, which deletes every download and would leave the cache cold
OA_BOOT_APT_CLEANER=/etc/apt/apt.conf.d/docker-clean
OA_BOOT_POLICY=/usr/sbin/policy-rc.d
OA_BOOT_SERVICES=/etc/service
# the second line of every policy-rc.d open-agent writes, and the third of the
# one that keeps every service from starting while the packages are reinstalled
OA_BOOT_POLICY_MARK='# open-agent policy-rc.d'
OA_BOOT_HOLD_MARK='# open-agent: no service starts while the packages are reinstalled'
# the system's jq, which the hook reads JSON with, never a tool link
OA_BOOT_JQ=/usr/bin/jq
# removes every directory a setup secret was delivered in, under the secret prefix
OA_BOOT_SECRETS_SWEEP="rm -rf ${OA_SECRET_PREFIX}*"
# the boot log's size beyond which it is trimmed, and how much a trim keeps
OA_BOOT_LOG_LIMIT=524288
OA_BOOT_LOG_KEPT=262144
# the exit of a boot a critical step halted
OA_BOOT_HALTED=3
# how often a boot looks for runit, which setup installs after the hook
OA_BOOT_POLL_SECONDS=5
# seconds between the attempts to reinstall the recorded packages
OA_BOOT_REPLAY_DELAYS='5 15'

# lists the packages dpkg has installed, one name a line, sorted
oa_boot_installed() {
  dpkg-query -W -f="\${db:Status-Abbrev} \${Package}\n" | awk '$1 == "ii" { print $2 }' | sort -u
}

# adds to the volume's record every package installed beyond the image's own,
# so a rebuilt root filesystem reinstalls it; a package stays recorded even
# once it is removed, as a reinstall of it from the cache is harmless
oa_boot_record() {
  test -f "$OA_BOOT_BASELINE" || return 0
  mountpoint -q "$OA_FLY_VOLUME" || return 0
  test -d "$OA_FLY_VOLUME_APT" || return 0
  oa_boot_added=$(mktemp) || return 1
  if oa_boot_installed | comm -23 - "$OA_BOOT_BASELINE" >"$oa_boot_added" &&
    touch "$OA_FLY_PACKAGES" &&
    sort -u "$OA_FLY_PACKAGES" "$oa_boot_added" >"$OA_FLY_PACKAGES.new" &&
    mv -f "$OA_FLY_PACKAGES.new" "$OA_FLY_PACKAGES"; then
    oa_boot_recorded=0
  else
    oa_boot_recorded=1
  fi
  rm -f "$oa_boot_added"
  return "$oa_boot_recorded"
}

# tells whether a directory is root's alone: a real directory root owns that
# no group or other account can write
# arguments: the directory
oa_boot_root_only() {
  test -d "$1" && ! test -L "$1" &&
    test "$(stat -c %u "$1")" = 0 &&
    test $((0$(stat -c %a "$1") & 022)) -eq 0
}

# tells whether root may run a file: a regular file root's alone, as is every
# directory above it
# arguments: the file
oa_boot_trusted() {
  test -f "$1" && ! test -L "$1" || return 1
  test "$(stat -c %u "$1")" = 0 || return 1
  test $((0$(stat -c %a "$1") & 022)) -eq 0 || return 1
  oa_boot_directory=${1%/*}
  while test -n "$oa_boot_directory"; do
    oa_boot_root_only "$oa_boot_directory" || return 1
    oa_boot_directory=${oa_boot_directory%/*}
  done
  oa_boot_root_only /
}

# runs one function of a guest library in a shell of its own, with the family
# library sourced first, once both are root's alone
# arguments: the library, then the function and its arguments
oa_boot_call() {
  for oa_boot_library in "$OA_BOOT_FAMILY" "$1"; do
    if ! oa_boot_trusted "$oa_boot_library"; then
      echo "Refusing $oa_boot_library: it is missing or not root's alone"
      return 1
    fi
  done
  /bin/sh -c '. "$1" && . "$2" && shift 2 && "$@"' oa-boot "$OA_BOOT_FAMILY" "$@"
}

# tells whether two paths are one directory, as a bind mount makes them
# arguments: the two paths
oa_boot_same() {
  test -e "$1" && test -e "$2" &&
    test "$(stat -c '%d %i' "$1")" = "$(stat -c '%d %i' "$2")"
}

# binds a volume directory over its root filesystem path, once per boot;
# anything else already mounted there is refused
# arguments: the volume directory, the root filesystem path
oa_boot_bind() {
  if oa_boot_same "$1" "$2"; then
    return 0
  fi
  if mountpoint -q "$2" 2>/dev/null; then
    echo "Refusing $2: something other than $1 is mounted there"
    return 1
  fi
  mkdir -p "$2" && mount --bind "$1" "$2"
}

# fails unless an account holds the ids its home on the volume was made under
# arguments: the account, its uid, its gid
oa_boot_owner() {
  if test "$(id -u "$1")" != "$2" || test "$(id -g "$1")" != "$3"; then
    echo "Refusing $1: it holds ids other than those its home on the volume was made under"
    return 1
  fi
}

# the volume must be mounted, and it and its homes root's alone, before
# anything is bound
oa_boot_volume() {
  if ! mountpoint -q "$OA_FLY_VOLUME"; then
    echo "No volume is mounted at $OA_FLY_VOLUME"
    return 1
  fi
  if ! oa_boot_root_only "$OA_FLY_VOLUME"; then
    echo "$OA_FLY_VOLUME is not root's alone"
    return 1
  fi
  if ! test -e "$OA_FLY_VOLUME_HOMES"; then
    install -d -m 0755 "$OA_FLY_VOLUME_HOMES" || return 1
  fi
  if ! oa_boot_root_only "$OA_FLY_VOLUME_HOMES"; then
    echo "$OA_FLY_VOLUME_HOMES is not root's alone"
    return 1
  fi
}

# root runs everything under the guest root, so it must be root's alone
oa_boot_guest_root() {
  if ! oa_boot_root_only "$OA_FLY_VOLUME_ROOT"; then
    echo "$OA_FLY_VOLUME_ROOT is not root's alone"
    return 1
  fi
  oa_boot_bind "$OA_FLY_VOLUME_ROOT" "$OA_GUEST_ROOT"
}

# the family library every later step calls must be root's alone
oa_boot_libraries() {
  if ! oa_boot_trusted "$OA_BOOT_FAMILY"; then
    echo "Refusing $OA_BOOT_FAMILY: it is missing or not root's alone"
    return 1
  fi
}

# the agent's account and its home: a new home on the volume is made from the
# skeleton under the agent's fixed ids, filled while it is still root's and
# out of reach, then handed over and moved into place, so root never writes
# into a directory the agent owns; an existing one keeps its ids, which the
# account is recreated under
oa_boot_agent() {
  oa_boot_home=$OA_FLY_VOLUME_AGENT_HOME
  if test -L "$oa_boot_home"; then
    echo "Refusing $oa_boot_home: it is a link"
    return 1
  fi
  if ! test -e "$oa_boot_home"; then
    rm -rf "$oa_boot_home.open-agent-new" &&
      install -d -m 0700 "$oa_boot_home.open-agent-new" || return 1
    if test -d /etc/skel; then
      cp -R /etc/skel/. "$oa_boot_home.open-agent-new" || return 1
    fi
    chown -R "$OA_AGENT_ID:$OA_AGENT_ID" "$oa_boot_home.open-agent-new" &&
      mv -T "$oa_boot_home.open-agent-new" "$oa_boot_home" || return 1
  fi
  if ! test -d "$oa_boot_home" || test "$(stat -c %u "$oa_boot_home")" = 0; then
    echo "Refusing $oa_boot_home: it is not a directory the agent owns"
    return 1
  fi
  oa_boot_uid=$(stat -c %u "$oa_boot_home") || return 1
  oa_boot_gid=$(stat -c %g "$oa_boot_home") || return 1
  oa_boot_bind "$oa_boot_home" "$OA_AGENT_HOME" || return 1
  oa_boot_call "$OA_BOOT_FAMILY" oa_account_ensure agent "$oa_boot_uid" "$oa_boot_gid" \
    "$OA_AGENT_HOME" /bin/bash user || return 1
  oa_boot_owner agent "$oa_boot_uid" "$oa_boot_gid" || return 1
  if test "$(getent passwd agent | cut -d: -f6)" != "$OA_AGENT_HOME"; then
    usermod --home "$OA_AGENT_HOME" agent
  fi
}

# Homebrew's home: one the installer has not taken yet stays root's, as the
# installer expects, and its account is left for setup to create; one it has
# taken has its account recreated under the ids it was made under
oa_boot_homebrew() {
  oa_boot_home=$OA_FLY_VOLUME_HOMEBREW_HOME
  if test -L "$oa_boot_home"; then
    echo "Refusing $oa_boot_home: it is a link"
    return 1
  fi
  if ! test -e "$oa_boot_home"; then
    install -d -m 0755 "$oa_boot_home" || return 1
  fi
  if ! test -d "$oa_boot_home"; then
    echo "Refusing $oa_boot_home: it is not a directory"
    return 1
  fi
  oa_boot_bind "$oa_boot_home" "$OA_LINUXBREW_HOME" || return 1
  oa_boot_uid=$(stat -c %u "$oa_boot_home") || return 1
  oa_boot_gid=$(stat -c %g "$oa_boot_home") || return 1
  if test "$oa_boot_uid" = 0; then
    echo "Homebrew is not installed on the volume yet"
    return 0
  fi
  oa_boot_call "$OA_BOOT_FAMILY" oa_account_ensure linuxbrew "$oa_boot_uid" "$oa_boot_gid" \
    "$OA_LINUXBREW_HOME" /usr/sbin/nologin system || return 1
  oa_boot_owner linuxbrew "$oa_boot_uid" "$oa_boot_gid"
}

# prints apt's configuration: every download stays in the volume's cache, and
# every dpkg run is recorded
oa_boot_apt_text() {
  cat <<EOF
// open-agent: apt keeps every download in the volume's cache, from which a
// rebuilt root filesystem reinstalls, and records what dpkg installs
Dir::Cache::archives "$OA_FLY_VOLUME_APT/archives/";
Binary::apt::APT::Keep-Downloaded-Packages "true";
APT::Keep-Downloaded-Packages "true";
DPkg::Post-Invoke { "/bin/sh $OA_BOOT_SELF record-packages || true"; };
EOF
}

# keeps apt's downloads in the volume's cache and its lists on the volume
oa_boot_apt() {
  rm -f "$OA_BOOT_APT_CLEANER" || return 1
  install -d -m 0755 "$OA_FLY_VOLUME_APT" "$OA_FLY_VOLUME_APT/lists" "$OA_FLY_VOLUME_APT/archives" || return 1
  install -d -m 0700 "$OA_FLY_VOLUME_APT/lists/partial" "$OA_FLY_VOLUME_APT/archives/partial" || return 1
  if ! oa_boot_root_only "$OA_FLY_VOLUME_APT"; then
    echo "$OA_FLY_VOLUME_APT is not root's alone"
    return 1
  fi
  if ! oa_boot_apt_text | cmp -s - "$OA_BOOT_APT_CONFIG"; then
    oa_boot_apt_text >"$OA_BOOT_APT_CONFIG.new" || return 1
    chmod 0644 "$OA_BOOT_APT_CONFIG.new" || return 1
    mv -f "$OA_BOOT_APT_CONFIG.new" "$OA_BOOT_APT_CONFIG" || return 1
  fi
  oa_boot_bind "$OA_FLY_VOLUME_APT/lists" /var/lib/apt/lists
}

# keeps every service a package ships from starting while the packages are
# reinstalled, since runit runs the services; a policy-rc.d another tool
# wrote is left as it is
oa_boot_hold() {
  if test -e "$OA_BOOT_POLICY" && test "$(sed -n 2p "$OA_BOOT_POLICY")" != "$OA_BOOT_POLICY_MARK"; then
    echo "Keeping the policy-rc.d another tool wrote"
    return 0
  fi
  printf '#!/bin/sh\n%s\n%s\nexit 101\n' "$OA_BOOT_POLICY_MARK" "$OA_BOOT_HOLD_MARK" \
    >"$OA_BOOT_POLICY.new" || return 1
  chmod 0755 "$OA_BOOT_POLICY.new" || return 1
  mv -f "$OA_BOOT_POLICY.new" "$OA_BOOT_POLICY"
}

# puts back the masking of the vendor services environment.json records,
# which replaces the hold, or drops the hold when it records none; without
# jq the hold stays, so still no service starts on its own
oa_boot_release() {
  oa_boot_units=
  if test -f "$OA_ENVIRONMENT_PATH"; then
    if ! test -x "$OA_BOOT_JQ"; then
      echo "Keeping every service from starting: no $OA_BOOT_JQ reads $OA_ENVIRONMENT_PATH"
      return 1
    fi
    oa_boot_units=$("$OA_BOOT_JQ" -r '[.tools[]?.source.vendorServices[]?] | unique | .[]' \
      "$OA_ENVIRONMENT_PATH") || return 1
  fi
  if test -n "$oa_boot_units"; then
    set --
    while read -r oa_boot_unit; do
      set -- "$@" "$oa_boot_unit"
    done <<EOF
$oa_boot_units
EOF
    oa_boot_call "$OA_BOOT_FAMILY" oa_mask_service "$@"
    return
  fi
  if test "$(sed -n 3p "$OA_BOOT_POLICY" 2>/dev/null)" = "$OA_BOOT_HOLD_MARK"; then
    rm -f "$OA_BOOT_POLICY"
  fi
}

# reinstalls the recorded packages on a root filesystem not restored yet,
# from apt's lists and cache on the volume alone, after their repositories
oa_boot_packages() {
  if test -z "$oa_boot_fresh"; then
    echo "The root filesystem is restored already"
    return 0
  fi
  if ! test -s "$OA_FLY_PACKAGES"; then
    echo "No packages are recorded yet"
    return 0
  fi
  set --
  while read -r oa_boot_package; do
    test -n "$oa_boot_package" && set -- "$@" "$oa_boot_package"
  done <<EOF
$(grep -Ex '[a-z0-9][a-z0-9.+-]*' "$OA_FLY_PACKAGES")
EOF
  if test "$#" -eq 0; then
    return 0
  fi
  oa_boot_hold || return 1
  echo "Reinstalling $*"
  for oa_boot_delay in $OA_BOOT_REPLAY_DELAYS ''; do
    oa_boot_call "$OA_BOOT_FAMILY" oa_replay "$@"
    oa_boot_replayed=$?
    if test "$oa_boot_replayed" = 0 || test -z "$oa_boot_delay"; then
      break
    fi
    echo "Reinstalling failed; retrying in $oa_boot_delay seconds"
    sleep "$oa_boot_delay"
  done
  oa_boot_release || return 1
  return "$oa_boot_replayed"
}

# restores the links of every Homebrew tool environment.json records
oa_boot_links() {
  if ! test -f "$OA_ENVIRONMENT_PATH"; then
    echo "Setup has recorded no tools yet"
    return 0
  fi
  oa_boot_call "$OA_BOOT_LINKS" oa_links_restore "$OA_ENVIRONMENT_PATH"
}

# puts back the services and jobs environment.json records on a root
# filesystem not restored yet; runsvdir starts the services once it runs
oa_boot_services() {
  if test -z "$oa_boot_fresh"; then
    echo "The root filesystem is restored already"
    return 0
  fi
  if ! test -f "$OA_ENVIRONMENT_PATH"; then
    echo "Setup has recorded no services yet"
    return 0
  fi
  oa_boot_call "$OA_BOOT_RUNIT" oa_sv_install "$OA_ENVIRONMENT_PATH" || return 1
  oa_boot_call "$OA_BOOT_CRON" oa_cron_install "$OA_ENVIRONMENT_PATH"
}

# prints the login profile: root's PATH puts the system's commands ahead of
# the tool links, and an ordinary account's its own commands, then
# Homebrew's, ahead of the system's
oa_boot_profile_text() {
  cat <<PROFILE
# open-agent: the system's commands ahead of the tool links for root; its own
# commands, then Homebrew's, ahead of the system's for an ordinary account
if test "\$(id -u)" = 0; then
  PATH="$OA_SESSION_PATH"
else
  PATH="\$HOME/.local/bin:$OA_ACCOUNT_PATH"
fi
export PATH
PROFILE
}

# writes the login profile every login shell reads
oa_boot_profile() {
  if oa_boot_profile_text | cmp -s - "$OA_FLY_PROFILE"; then
    return 0
  fi
  install -d -m 0755 "${OA_FLY_PROFILE%/*}" || return 1
  oa_boot_profile_text >"$OA_FLY_PROFILE.new" || return 1
  chmod 0644 "$OA_FLY_PROFILE.new" || return 1
  mv -f "$OA_FLY_PROFILE.new" "$OA_FLY_PROFILE"
}

# recreates the machine information file from the workstation name setup
# recorded under the guest root, keeping any other key the file has; a record
# that is not root's alone or not a DNS label is refused
oa_boot_label() {
  if ! test -e "$OA_WORKSTATION_NAME_PATH"; then
    echo "No workstation name is recorded yet"
    return 0
  fi
  if ! oa_boot_trusted "$OA_WORKSTATION_NAME_PATH"; then
    echo "Refusing $OA_WORKSTATION_NAME_PATH: it is a link or not root's alone"
    return 1
  fi
  oa_boot_label=$(head -n 1 "$OA_WORKSTATION_NAME_PATH")
  if ! printf '%s\n' "$oa_boot_label" | grep -Eqx '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'; then
    echo "Refusing $OA_WORKSTATION_NAME_PATH: it holds no DNS label"
    return 1
  fi
  {
    if test -f "$OA_MACHINE_INFO_PATH"; then
      grep -v "^[[:space:]]*${OA_MACHINE_INFO_LABEL_KEY}[[:space:]]*=" "$OA_MACHINE_INFO_PATH" || :
    fi
    printf '%s=%s\n' "$OA_MACHINE_INFO_LABEL_KEY" "$oa_boot_label"
  } >"$OA_MACHINE_INFO_PATH.new" || return 1
  if cmp -s "$OA_MACHINE_INFO_PATH.new" "$OA_MACHINE_INFO_PATH"; then
    rm -f "$OA_MACHINE_INFO_PATH.new"
    return 0
  fi
  chmod 0644 "$OA_MACHINE_INFO_PATH.new" || return 1
  mv -f "$OA_MACHINE_INFO_PATH.new" "$OA_MACHINE_INFO_PATH"
}

# lets every group open ping's sockets, where the kernel allows it
oa_boot_ping() {
  oa_boot_call "$OA_BOOT_FAMILY" oa_sysctl net.ipv4.ping_group_range "$OA_PING_GROUP_RANGE"
}

# removes what a crash left of setup's secrets in /dev/shm, under the setup
# session's lock and only while no session holds it, so a prepare inside a
# session or a resume after one leaves the session's own secret alone
oa_boot_secrets() {
  if test -d "$OA_SESSION_DIRECTORY"; then
    flock -n "$OA_SESSION_LOCK" /bin/sh -c "$OA_BOOT_SECRETS_SWEEP" ||
      echo "a setup session is open; its secrets are left to it"
  else
    /bin/sh -c "$OA_BOOT_SECRETS_SWEEP"
  fi
}

# tells whether an account holds the ids of its home on the volume
# arguments: the account, its home on the volume
oa_boot_holds() {
  getent passwd "$1" >/dev/null &&
    oa_boot_owner "$1" "$(stat -c %u "$2")" "$(stat -c %g "$2")" >/dev/null
}

# tells whether this boot's ready file says a critical step halted it
oa_boot_halted_boot() {
  test "$(cat "$OA_FLY_BOOT_READY" 2>/dev/null)" = "$(cat "$OA_BOOT_ID_PATH") halted"
}

# tells whether a prepare would change nothing setup needs: the boot did not
# halt, the volume's directories are bound, the accounts hold their homes' ids, and apt and the
# login profile are as the hook writes them. Packages a boot failed to
# reinstall are left to setup's own steps, which fetch them, and to the next
# boot, which marks the root filesystem restored
oa_boot_check() {
  ! oa_boot_halted_boot || return 1
  oa_boot_same "$OA_FLY_VOLUME_ROOT" "$OA_GUEST_ROOT" || return 1
  oa_boot_same "$OA_FLY_VOLUME_HOMES/agent" "$OA_AGENT_HOME" || return 1
  oa_boot_holds agent "$OA_FLY_VOLUME_HOMES/agent" || return 1
  test "$(getent passwd agent | cut -d: -f6)" = "$OA_AGENT_HOME" || return 1
  oa_boot_same "$OA_FLY_VOLUME_HOMES/linuxbrew" "$OA_LINUXBREW_HOME" || return 1
  if test "$(stat -c %u "$OA_FLY_VOLUME_HOMES/linuxbrew")" != 0; then
    oa_boot_holds linuxbrew "$OA_FLY_VOLUME_HOMES/linuxbrew" || return 1
  fi
  ! test -e "$OA_BOOT_APT_CLEANER" || return 1
  oa_boot_apt_text | cmp -s - "$OA_BOOT_APT_CONFIG" || return 1
  oa_boot_same "$OA_FLY_VOLUME_APT/lists" /var/lib/apt/lists || return 1
  oa_boot_profile_text | cmp -s - "$OA_FLY_PROFILE"
}

# prints the milliseconds since the epoch
oa_boot_now() {
  date +%s%3N
}

# writes one line to the run's log and to standard output, which the stub
# hands to the console Fly keeps as the machine's log
# arguments: the message
oa_boot_log() {
  oa_boot_line="open-agent-boot $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\n' "$oa_boot_line" >>"$oa_boot_sink"
  printf '%s\n' "$oa_boot_line"
}

# runs one step in a subshell with its output in the run's log, then logs its
# outcome and duration; a failed critical step skips every later step, which
# would otherwise write the volume's data onto the root filesystem
# arguments: the step's name, critical or optional, then its function
oa_boot_step() {
  oa_boot_step_name=$1
  oa_boot_step_kind=$2
  shift 2
  if test "$oa_boot_halted" = 1; then
    oa_boot_outcome=skipped
    oa_boot_took=0
  else
    oa_boot_begun=$(oa_boot_now)
    if ("$@") >>"$oa_boot_sink" 2>&1; then
      oa_boot_outcome=ok
    else
      oa_boot_outcome=failed
      oa_boot_failed=1
      if test "$oa_boot_step_kind" = critical; then
        oa_boot_halted=1
      fi
    fi
    oa_boot_took=$(($(oa_boot_now) - oa_boot_begun))
  fi
  oa_boot_log "step=$oa_boot_step_name outcome=$oa_boot_outcome duration_ms=$oa_boot_took"
  oa_boot_steps="$oa_boot_steps${oa_boot_steps:+,}\"$oa_boot_step_name\":{\"outcome\":\"$oa_boot_outcome\",\"durationMs\":$oa_boot_took}"
}

# records the image's packages, once per root filesystem and before any
# package is reinstalled, so the record holds only what setup added
oa_boot_baseline() {
  test -f "$OA_BOOT_BASELINE" && return 0
  install -d -m 0755 "$OA_FLY_ROOTFS_STATE" || return 1
  oa_boot_installed >"$OA_BOOT_BASELINE.new" || return 1
  mv -f "$OA_BOOT_BASELINE.new" "$OA_BOOT_BASELINE"
}

# marks the root filesystem restored
oa_boot_mark() {
  install -d -m 0755 "$OA_FLY_ROOTFS_STATE" || return 1
  printf '%s\n' "$oa_boot_id" >"$OA_FLY_ROOTFS_RESTORED"
}

# runs every step in order; the marker is left once the packages, services
# and jobs are back, so a failed reinstall is retried on the next run
oa_boot_restore() {
  oa_boot_fresh=
  if ! test -f "$OA_FLY_ROOTFS_RESTORED"; then
    oa_boot_fresh=1
  fi
  oa_boot_baseline || oa_boot_log "could not record the image's packages"
  oa_boot_incomplete=
  oa_boot_step secrets optional oa_boot_secrets
  oa_boot_step volume critical oa_boot_volume
  oa_boot_step guest-root critical oa_boot_guest_root
  # the log reaches the volume once the guest root is bound
  if oa_boot_same "$OA_FLY_VOLUME_ROOT" "$OA_GUEST_ROOT"; then
    oa_boot_keep_log || oa_boot_log "could not keep the log in $OA_FLY_BOOT_LOG"
  fi
  oa_boot_step libraries critical oa_boot_libraries
  oa_boot_step agent-account critical oa_boot_agent
  oa_boot_step homebrew-account critical oa_boot_homebrew
  oa_boot_step apt-cache optional oa_boot_apt
  oa_boot_step packages optional oa_boot_packages
  test "$oa_boot_outcome" = ok || oa_boot_incomplete=1
  oa_boot_step links optional oa_boot_links
  # the restored links bring runit's commands onto PATH, after the system's,
  # which no link shadows; root runs Homebrew's runit only because the
  # Homebrew account is locked and root alone writes it, acting as it
  PATH=$OA_SESSION_PATH
  oa_boot_step services optional oa_boot_services
  test "$oa_boot_outcome" = ok || oa_boot_incomplete=1
  oa_boot_step profile optional oa_boot_profile
  oa_boot_step label optional oa_boot_label
  oa_boot_step ping optional oa_boot_ping
  if test "$oa_boot_halted" = 0 && test -z "$oa_boot_incomplete" && test -n "$oa_boot_fresh"; then
    oa_boot_mark || oa_boot_log "could not mark the root filesystem restored"
  fi
}

# moves the run's log so far onto the boot log on the volume, trimming it,
# and writes the rest of the run there
oa_boot_keep_log() {
  if ! test -e "$OA_FLY_BOOT_LOG"; then
    install -m 0600 /dev/null "$OA_FLY_BOOT_LOG" || return 1
  fi
  cat "$oa_boot_sink" >>"$OA_FLY_BOOT_LOG" || return 1
  if test "$(stat -c %s "$OA_FLY_BOOT_LOG")" -gt "$OA_BOOT_LOG_LIMIT"; then
    tail -c "$OA_BOOT_LOG_KEPT" "$OA_FLY_BOOT_LOG" >"$OA_FLY_BOOT_LOG.new" || return 1
    mv -f "$OA_FLY_BOOT_LOG.new" "$OA_FLY_BOOT_LOG" || return 1
  fi
  oa_boot_sink=$OA_FLY_BOOT_LOG
}

# writes the ready file the host waits for, naming this boot
# arguments: ok; halted, when a critical step failed with the guest root on
# the volume, so setup may repair it; failed, when the guest root is not;
# or resumed, when a prepare repaired a halted boot
oa_boot_ready() {
  printf '%s %s\n' "$oa_boot_id" "$1" >"$OA_FLY_BOOT_READY.new" &&
    mv -f "$OA_FLY_BOOT_READY.new" "$OA_FLY_BOOT_READY"
}

# writes the boot's result and every step's for doctor
# arguments: ok, failed or halted
oa_boot_report() {
  printf '{"bootId":"%s","startedAt":"%s","status":"%s","durationMs":%s,"steps":{%s}}\n' \
    "$oa_boot_id" "$oa_boot_started" "$1" "$oa_boot_duration" "$oa_boot_steps" \
    >"$OA_FLY_BOOT_STATUS.new" || return 1
  chmod 0644 "$OA_FLY_BOOT_STATUS.new" || return 1
  mv -f "$OA_FLY_BOOT_STATUS.new" "$OA_FLY_BOOT_STATUS"
}

# replaces the boot with runsvdir, waiting for setup to install runit first
oa_boot_handover() {
  install -d -m 0755 "$OA_BOOT_SERVICES" || oa_boot_log "could not make $OA_BOOT_SERVICES"
  oa_boot_waiting=
  until oa_boot_runsvdir=$(command -v runsvdir); do
    if test -z "$oa_boot_waiting"; then
      oa_boot_log "handover=waiting for setup to install runit"
      oa_boot_waiting=1
    fi
    sleep "$OA_BOOT_POLL_SECONDS"
  done
  oa_boot_log "handover=runsvdir"
  exec "$oa_boot_runsvdir" -P "$OA_BOOT_SERVICES"
}

case ${1-boot} in
  record-packages)
    oa_boot_record || :
    exit 0
    ;;
  check)
    oa_boot_check
    exit
    ;;
  boot | prepare)
    oa_boot_mode=${1-boot}
    ;;
  *)
    echo "boot hook: unknown argument $1" >&2
    exit 1
    ;;
esac

install -d -m 0755 "$OA_FLY_RUN" || exit 1
oa_boot_sink=$OA_FLY_RUN/boot-$oa_boot_mode.log
: >"$oa_boot_sink" || exit 1
chmod 0600 "$oa_boot_sink" || exit 1
oa_boot_id=$(cat "$OA_BOOT_ID_PATH")
oa_boot_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
oa_boot_began=$(oa_boot_now)
oa_boot_halted=0
oa_boot_failed=0
oa_boot_steps=
oa_boot_outcome=

# one run at a time: a boot waits for setup's prepare, and setup for a boot
exec 9>"$OA_BOOT_LOCK"
if ! flock -w "$OA_BOOT_LOCK_WAIT" 9; then
  echo "Another run of the boot hook held its lock for $OA_BOOT_LOCK_WAIT seconds" >&2
  exit 1
fi
oa_boot_log "$oa_boot_mode id=$oa_boot_id started"
oa_boot_restore
oa_boot_result=ok
if test "$oa_boot_halted" = 1; then
  oa_boot_result=halted
elif test "$oa_boot_failed" = 1; then
  oa_boot_result=failed
fi
oa_boot_duration=$(($(oa_boot_now) - oa_boot_began))
oa_boot_log "$oa_boot_mode status=$oa_boot_result duration_ms=$oa_boot_duration"
exec 9>&-

if test "$oa_boot_mode" = prepare; then
  if test "$oa_boot_failed" = 1; then
    echo "The boot hook failed a step; see $oa_boot_sink" >&2
  fi
  test "$oa_boot_halted" = 0 || exit 1
  # a repaired boot the stub has halted runs again, through to runsvdir
  if oa_boot_halted_boot; then
    oa_boot_log "prepare repaired the halted boot; the stub runs it again"
    oa_boot_ready resumed || exit 1
  fi
  exit 0
fi
if test "$oa_boot_sink" = "$OA_FLY_BOOT_LOG"; then
  oa_boot_report "$oa_boot_result" || oa_boot_log "could not write $OA_FLY_BOOT_STATUS"
fi
if test "$oa_boot_halted" = 1; then
  # setup may repair the guest only while its root is the volume's
  if oa_boot_same "$OA_FLY_VOLUME_ROOT" "$OA_GUEST_ROOT"; then
    oa_boot_ready halted
    oa_boot_log "handover=none: a critical step failed; setup can repair the guest before the stub stops the machine; see $oa_boot_sink"
  else
    oa_boot_ready failed
    oa_boot_log "handover=none: a critical step failed; see $oa_boot_sink"
  fi
  exit "$OA_BOOT_HALTED"
fi
oa_boot_ready ok
oa_boot_handover
