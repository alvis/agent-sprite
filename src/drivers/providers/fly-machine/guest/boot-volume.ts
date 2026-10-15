// the boot script's volume and account steps: they bind the volume's
// directories and recreate the accounts that own them, never changing an owner

import { AGENT_HOME, GUEST_ROOT } from '#guest/guest-root';
import { HOMEBREW } from '#guest/homebrew';

import {
  AGENT_IDS,
  HOMEBREW_IDS,
  SYSTEM_ID_MAX,
  VOLUME_LAYOUT,
} from './boot-paths.js';

/**
 * the checks that a directory is root's alone and that root may run a file, and the bind mount every volume path takes
 * @returns the section's text
 */
export function guardSection(): string {
  return `# tells whether a directory is root's alone: a real directory root owns that
# no group or other account can write
is_root_only() {
  test -d "$1" && ! test -L "$1" || return 1
  test "$(stat -c %u "$1")" = 0 || return 1
  test $((0$(stat -c %a "$1") & 022)) -eq 0
}

# tells whether root may run a file: root's alone, as is every directory
# above it
is_trusted_entry() {
  test -f "$1" && ! test -L "$1" && test -x "$1" || return 1
  test "$(stat -c %u "$1")" = 0 || return 1
  test $((0$(stat -c %a "$1") & 022)) -eq 0 || return 1
  directory=$(dirname "$1")
  while :; do
    is_root_only "$directory" || return 1
    test "$directory" = / && return 0
    directory=$(dirname "$directory")
  done
}

# binds a volume directory over its root filesystem path, once per boot
bind() {
  if mountpoint -q "$2"; then
    return 0
  fi
  mkdir -p "$2"
  mount --bind "$1" "$2"
}`;
}

/**
 * the steps that check the volume and bind the guest root from it
 * @returns the section's text
 */
export function volumeSection(): string {
  return `# the volume must be mounted, and root's alone, before anything is bound
check_volume() {
  if ! mountpoint -q "$volume"; then
    echo "No volume is mounted at $volume"
    return 1
  fi
  is_root_only "$volume" || { echo "$volume is not root's alone"; return 1; }
  if ! test -e "${VOLUME_LAYOUT.homes}"; then
    install -d -m 0755 "${VOLUME_LAYOUT.homes}"
  fi
  is_root_only "${VOLUME_LAYOUT.homes}" || { echo "${VOLUME_LAYOUT.homes} is not root's alone"; return 1; }
}

# root runs everything under the guest root, so it must be root's alone
mount_guest_root() {
  if ! test -e "${VOLUME_LAYOUT.guestRoot}"; then
    install -d -m 0755 "${VOLUME_LAYOUT.guestRoot}"
  fi
  is_root_only "${VOLUME_LAYOUT.guestRoot}" || { echo "${VOLUME_LAYOUT.guestRoot} is not root's alone"; return 1; }
  bind "${VOLUME_LAYOUT.guestRoot}" "${GUEST_ROOT}"
}`;
}

/**
 * recreates an account under the ids its home on the volume was made under, or its fixed ids
 * @returns the section's text
 */
export function accountSection(): string {
  return `# recreates an account under the ids its surviving home on the volume was
# made under, so no file changes owner; an account with no home yet takes
# its fixed ids. Ids another account or group holds are refused, and a
# system account takes system ids only
# arguments: name, fixed uid, fixed gid, home, volume source, shell, kind
ensure_account() {
  name=$1
  uid=$2
  gid=$3
  home=$4
  source=$5
  shell=$6
  kind=$7
  if getent passwd "$name" >/dev/null; then
    return 0
  fi
  if test -d "$source" && test "$(stat -c %u "$source")" != 0; then
    uid=$(stat -c %u "$source")
    gid=$(stat -c %g "$source")
    echo "Recreating $name under the ids $uid:$gid of its home on the volume"
  fi
  system=
  if test "$kind" = system; then
    system=--system
    if test "$uid" -lt 1 || test "$uid" -gt ${SYSTEM_ID_MAX} || \\
        test "$gid" -lt 1 || test "$gid" -gt ${SYSTEM_ID_MAX}; then
      echo "Refusing $name: $uid:$gid are not system ids"
      return 1
    fi
  fi
  if getent passwd "$uid" >/dev/null; then
    echo "Refusing $name: another account holds user id $uid"
    return 1
  fi
  if group=$(getent group "$name"); then
    if test "$(printf '%s' "$group" | cut -d: -f3)" != "$gid"; then
      echo "Refusing $name: its group exists under another id"
      return 1
    fi
  elif getent group "$gid" >/dev/null; then
    echo "Refusing $name: another group holds group id $gid"
    return 1
  else
    groupadd $system --gid "$gid" "$name" || return 1
  fi
  useradd $system --uid "$uid" --gid "$name" --home-dir "$home" \\
    --no-create-home --shell "$shell" "$name"
}`;
}

/**
 * the steps that restore the agent and Homebrew accounts and bind their homes
 * @returns the section's text
 */
export function homeSection(): string {
  return `# the agent account and its home: a new home is made from the skeleton the
# way useradd makes one, then the account is pointed at the bound path
restore_agent() {
  ensure_account agent ${AGENT_IDS.uid} ${AGENT_IDS.gid} ${AGENT_HOME} \\
    "${VOLUME_LAYOUT.agentHome}" /bin/bash user || return 1
  if ! test -e "${VOLUME_LAYOUT.agentHome}"; then
    usermod --home "${VOLUME_LAYOUT.agentHome}" agent || return 1
    mkhomedir_helper agent 0077 /etc/skel || return 1
  fi
  if test "$(getent passwd agent | cut -d: -f6)" != ${AGENT_HOME}; then
    usermod --home ${AGENT_HOME} agent || return 1
  fi
  if test -L "${VOLUME_LAYOUT.agentHome}" || \\
      test "$(stat -c %u "${VOLUME_LAYOUT.agentHome}")" = 0; then
    echo "Refusing ${VOLUME_LAYOUT.agentHome}: it is a link or root's"
    return 1
  fi
  bind "${VOLUME_LAYOUT.agentHome}" ${AGENT_HOME}
}

# the Homebrew account: no login shell, a locked password, no sudo rule and no
# other group; a home the installer has not taken yet stays root's, as the
# installer expects
restore_homebrew() {
  ensure_account ${HOMEBREW.account} ${HOMEBREW_IDS.uid} ${HOMEBREW_IDS.gid} ${HOMEBREW.home} \\
    "${VOLUME_LAYOUT.homebrewHome}" /usr/sbin/nologin system || return 1
  if ! test -e "${VOLUME_LAYOUT.homebrewHome}"; then
    install -d -m 0755 "${VOLUME_LAYOUT.homebrewHome}" || return 1
  fi
  if test -L "${VOLUME_LAYOUT.homebrewHome}" || ! test -d "${VOLUME_LAYOUT.homebrewHome}"; then
    echo "Refusing ${VOLUME_LAYOUT.homebrewHome}: it is not a directory"
    return 1
  fi
  bind "${VOLUME_LAYOUT.homebrewHome}" ${HOMEBREW.home}
}`;
}
