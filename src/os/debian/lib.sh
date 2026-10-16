# open-agent's debian family library: the package, repository, account,
# kernel and service helpers that setup, the updater and the boot hook source
# as root. Every function is safe to rerun, reports why it failed on stderr
# and returns non-zero; none exits the shell or sets a trap in it, and each
# keeps its variables under its own oa_ prefix since sh has no locals

# the guest root, which outlives a rebuilt root filesystem: GUEST_ROOT in
# src/guest/guest-root.ts, which this shell cannot import
OA_GUEST_ROOT=/opt/open-agent
# seconds apt and dpkg wait for another package manager to let go of its lock
OA_LOCK_SECONDS=300
# minutes after which apt's lists are refreshed before an install
OA_LISTS_MAX_MINUTES=1440
# written whenever open-agent refreshed apt's lists; it sits in apt's periodic
# directory because apt-get update deletes what it does not know in the lists
OA_LISTS_STAMP=/var/lib/apt/periodic/open-agent-update-success-stamp
# where the keyrings and sources of added repositories go
OA_KEYRINGS=/etc/apt/keyrings
OA_SOURCES=/etc/apt/sources.list.d
# a copy of every added repository, which oa_replay puts back
OA_REPOSITORIES=$OA_GUEST_ROOT/apt-repositories
# the services whose vendor units are masked, one init script name a line
OA_MASKED_SERVICES=/etc/open-agent/masked-services
OA_POLICY_RC=/usr/sbin/policy-rc.d
# the second line of the policy-rc.d open-agent writes, after its shebang,
# which tells it apart from another's
OA_POLICY_MARK='# open-agent policy-rc.d'

# runs a command as an account from its home, without a PAM session or a
# sudo rule; root runs it directly
# arguments: account, then the program and its arguments
oa_as() {
  oa_as_account=$1
  shift
  if test "$oa_as_account" = root; then
    "$@"
    return
  fi
  oa_as_home=$(getent passwd "$oa_as_account" | cut -d: -f6)
  if test -z "$oa_as_home"; then
    echo "There is no account $oa_as_account to run $1 as" >&2
    return 1
  fi
  runuser -u "$oa_as_account" -- env --chdir="$oa_as_home" "$@"
}

# refuses any package name apt could read as an option or a pattern
# arguments: package names
oa_pkg_names() {
  for oa_names_package; do
    case $oa_names_package in
      '' | [!a-z0-9]* | *[!a-z0-9.+:-]*)
        echo "Refusing the package name $oa_names_package" >&2
        return 1
        ;;
    esac
  done
}

# runs apt-get without a question, keeping changed configuration files and
# waiting for another package manager's lock
# arguments: apt-get's arguments
oa_apt() {
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -q -y \
    -o DPkg::Lock::Timeout="$OA_LOCK_SECONDS" \
    -o Dpkg::Options::=--force-confdef \
    -o Dpkg::Options::=--force-confold \
    "$@"
}

# finishes the configuration an interrupted dpkg run left, waiting while
# another package manager holds dpkg's lock
oa_dpkg_repair() {
  oa_repair_deadline=$(($(date +%s) + OA_LOCK_SECONDS))
  while :; do
    if oa_repair_output=$(DEBIAN_FRONTEND=noninteractive \
      dpkg --force-confdef --force-confold --configure -a 2>&1); then
      test -z "$oa_repair_output" || printf '%s\n' "$oa_repair_output"
      return 0
    fi
    case $oa_repair_output in
      *lock*) ;;
      *)
        printf '%s\n' "$oa_repair_output" >&2
        return 1
        ;;
    esac
    if test "$(date +%s)" -ge "$oa_repair_deadline"; then
      echo "dpkg stayed locked for $OA_LOCK_SECONDS seconds" >&2
      return 1
    fi
    sleep 5
  done
}

# tells whether apt's lists are missing, older than open-agent keeps them, or
# invalidated by a repository just added
oa_lists_stale() {
  test -f "$OA_LISTS_STAMP" || return 0
  test -n "$(find "$OA_LISTS_STAMP" -mmin "-$OA_LISTS_MAX_MINUTES")" || return 0
  for oa_stale_list in /var/lib/apt/lists/*_Packages*; do
    test -e "$oa_stale_list" && return 1
  done
  return 0
}

# refreshes apt's lists, failing when any repository could not be read, and
# records that it did
oa_lists_update() {
  oa_apt --error-on=any update || return 1
  install -d -m 0755 "${OA_LISTS_STAMP%/*}" && : >"$OA_LISTS_STAMP" || return 1
  oa_lists_fresh=1
}

# refreshes apt's lists only when they are stale
oa_lists_refresh() {
  if oa_lists_stale; then
    oa_lists_update
  fi
}

# tells whether every named package is installed
# arguments: package names
oa_pkg_installed() {
  for oa_installed_package; do
    test "$(dpkg-query -W -f="\${db:Status-Abbrev}" "$oa_installed_package" 2>/dev/null)" = 'ii ' ||
      return 1
  done
}

# installs system packages without their recommendations: dpkg's interrupted
# runs are finished first, apt's lists are refreshed when stale, and once more
# when the install fails on lists that were not just refreshed
# arguments: package names
oa_pkg_install() {
  oa_pkg_names "$@" || return 1
  oa_dpkg_repair || return 1
  if oa_pkg_installed "$@"; then
    return 0
  fi
  oa_lists_refresh || return 1
  if oa_apt install --no-install-recommends "$@"; then
    return 0
  fi
  test -z "${oa_lists_fresh:-}" || return 1
  oa_lists_update && oa_apt install --no-install-recommends "$@"
}

# upgrades installed system packages, never installing a missing one
# arguments: package names
oa_pkg_upgrade() {
  oa_pkg_names "$@" || return 1
  oa_dpkg_repair || return 1
  oa_lists_refresh || return 1
  oa_apt install --only-upgrade --no-install-recommends "$@"
}

# prints the installed version of a system package
# arguments: package name
oa_pkg_version() {
  oa_pkg_names "$1" || return 1
  oa_pkg_installed "$1" || return 1
  dpkg-query -W -f="\${Version}\n" "$1"
}

# reads the release codename /etc/os-release names
oa_codename() {
  sed -n 's/^VERSION_CODENAME=["'\'']\{0,1\}\([a-z0-9]*\)["'\'']\{0,1\}$/\1/p' /etc/os-release |
    sed -n 1p
}

# downloads a repository's signing key and keeps, of the primary keys it
# holds, only those whose fingerprint is pinned, with their subkeys
# arguments: work directory, key URL, pinned fingerprints separated by blanks
oa_repo_key() {
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --max-time 120 \
    -o "$1/key" "$2" || return 1
  install -d -m 0700 "$1/gnupg" || return 1
  if ! gpg --homedir "$1/gnupg" --batch --no-autostart --quiet --import "$1/key" 2>"$1/import.log"; then
    cat "$1/import.log" >&2
    echo "The key at $2 is not a readable OpenPGP key" >&2
    return 1
  fi
  gpg --homedir "$1/gnupg" --batch --no-autostart --with-colons --list-keys 2>/dev/null |
    awk -F: '$1 == "pub" { primary = 1; next }
      $1 == "fpr" && primary { print $10; primary = 0 }
      $1 == "sub" { primary = 0 }' >"$1/primaries" || return 1
  : >"$1/keyring"
  for oa_key_pin in $3; do
    case $oa_key_pin in
      ????????????????????????????????????????) ;;
      *)
        echo "Refusing the pinned fingerprint $oa_key_pin: it is not 40 digits" >&2
        return 1
        ;;
    esac
    case $oa_key_pin in
      *[!0-9A-F]*)
        echo "Refusing the pinned fingerprint $oa_key_pin: it is not upper-case hex" >&2
        return 1
        ;;
    esac
    if grep -qxF -- "$oa_key_pin" "$1/primaries"; then
      gpg --homedir "$1/gnupg" --batch --no-autostart --export "$oa_key_pin" >>"$1/keyring" || return 1
    fi
  done
  if ! test -s "$1/keyring"; then
    echo "Refusing the key at $2: it carries none of the pinned fingerprints $3" >&2
    return 1
  fi
}

# writes a repository's files atomically and keeps a copy for oa_replay
# arguments: work directory holding keyring and list, repository id
oa_repo_install() {
  install -d -m 0755 "$OA_KEYRINGS" "$OA_SOURCES" || return 1
  install -d -m 0700 "$OA_REPOSITORIES" || return 1
  install -m 0644 "$1/keyring" "$OA_REPOSITORIES/$2.gpg" || return 1
  install -m 0644 "$1/list" "$OA_REPOSITORIES/$2.list" || return 1
  install -m 0644 "$1/keyring" "$OA_KEYRINGS/open-agent-$2.gpg.new" &&
    mv -f "$OA_KEYRINGS/open-agent-$2.gpg.new" "$OA_KEYRINGS/open-agent-$2.gpg" || return 1
  install -m 0644 "$1/list" "$OA_SOURCES/open-agent-$2.list.new" &&
    mv -f "$OA_SOURCES/open-agent-$2.list.new" "$OA_SOURCES/open-agent-$2.list" || return 1
  rm -f "$OA_LISTS_STAMP"
}

# adds a signed apt repository: its key is refused unless it carries a pinned
# fingerprint, only the pinned keys go into its own keyring under
# /etc/apt/keyrings, and its source names that keyring alone. A repository
# already added the same way is left as it is; adding or changing one makes
# the next install refresh apt's lists
# arguments: repository id, key URL, pinned fingerprints separated by blanks,
# repository URI, suite (`{codename}` stands for the release codename), components
oa_repo_add() {
  if test "$#" -lt 6; then
    echo "oa_repo_add needs an id, a key, its fingerprints, a URI, a suite and a component" >&2
    return 1
  fi
  oa_repo_id=$1
  oa_repo_key_url=$2
  oa_repo_pins=$3
  oa_repo_uri=$4
  oa_repo_suite=$5
  shift 5
  case $oa_repo_id in
    '' | [!a-z0-9]* | *[!a-z0-9-]*)
      echo "Refusing the repository id $oa_repo_id" >&2
      return 1
      ;;
  esac
  for oa_repo_word in "$oa_repo_key_url" "$oa_repo_uri"; do
    case $oa_repo_word in
      https://*) ;;
      *)
        echo "Refusing $oa_repo_word: a repository is fetched over https only" >&2
        return 1
        ;;
    esac
  done
  for oa_repo_word in "$oa_repo_key_url" "$oa_repo_uri" "$oa_repo_suite" "$@"; do
    case $oa_repo_word in
      '' | *[!A-Za-z0-9:/._~%+{}-]*)
        echo "Refusing the repository word $oa_repo_word" >&2
        return 1
        ;;
    esac
  done
  case $oa_repo_suite in
    *'{codename}'*)
      oa_repo_codename=$(oa_codename)
      if test -z "$oa_repo_codename"; then
        echo "The release names no codename for the repository $oa_repo_id" >&2
        return 1
      fi
      oa_repo_suite=$(printf '%s' "$oa_repo_suite" | sed "s/{codename}/$oa_repo_codename/g")
      ;;
  esac
  oa_repo_arch=$(dpkg --print-architecture) || return 1
  oa_repo_keyring=$OA_KEYRINGS/open-agent-$oa_repo_id.gpg
  oa_repo_list=$OA_SOURCES/open-agent-$oa_repo_id.list
  oa_repo_entry=$(printf '# open-agent repository %s, pinned to %s\ndeb [arch=%s signed-by=%s] %s %s %s' \
    "$oa_repo_id" "$oa_repo_pins" "$oa_repo_arch" "$oa_repo_keyring" \
    "$oa_repo_uri" "$oa_repo_suite" "$*")
  if test -s "$oa_repo_keyring" && test -f "$oa_repo_list" &&
    test "$(cat "$oa_repo_list")" = "$oa_repo_entry" &&
    test -s "$OA_REPOSITORIES/$oa_repo_id.gpg"; then
    return 0
  fi
  if ! command -v gpg >/dev/null 2>&1; then
    oa_pkg_install gpg || return 1
  fi
  oa_repo_work=$(mktemp -d) || return 1
  printf '%s\n' "$oa_repo_entry" >"$oa_repo_work/list" &&
    oa_repo_key "$oa_repo_work" "$oa_repo_key_url" "$oa_repo_pins" &&
    oa_repo_install "$oa_repo_work" "$oa_repo_id"
  oa_repo_status=$?
  rm -rf "$oa_repo_work"
  return "$oa_repo_status"
}

# puts back the repositories open-agent added, from its copy on the guest root
oa_repo_restore() {
  for oa_restore_list in "$OA_REPOSITORIES"/*.list; do
    test -f "$oa_restore_list" || continue
    oa_restore_id=${oa_restore_list##*/}
    oa_restore_id=${oa_restore_id%.list}
    install -d -m 0755 "$OA_KEYRINGS" "$OA_SOURCES" || return 1
    if ! cmp -s "$OA_REPOSITORIES/$oa_restore_id.gpg" "$OA_KEYRINGS/open-agent-$oa_restore_id.gpg"; then
      install -m 0644 "$OA_REPOSITORIES/$oa_restore_id.gpg" "$OA_KEYRINGS/open-agent-$oa_restore_id.gpg" || return 1
    fi
    if ! cmp -s "$oa_restore_list" "$OA_SOURCES/open-agent-$oa_restore_id.list"; then
      install -m 0644 "$oa_restore_list" "$OA_SOURCES/open-agent-$oa_restore_id.list" || return 1
    fi
  done
}

# reinstalls system packages on a rebuilt root filesystem from apt's local
# lists and download cache only, after putting back the added repositories;
# it never touches the network, so a package missing from the cache fails it
# arguments: package names
oa_replay() {
  oa_pkg_names "$@" || return 1
  oa_repo_restore || return 1
  oa_dpkg_repair || return 1
  if oa_pkg_installed "$@"; then
    return 0
  fi
  oa_apt install --no-download --no-upgrade --no-install-recommends "$@"
}

# creates an account with the given ids unless it exists; an existing one
# keeps its ids. Ids another account or group holds are refused, a system
# account takes system ids only and a locked password, an account in any
# group but its own and users is refused, and none is given a sudo rule. A
# missing home is created, owned by the account: a user's from the skeleton,
# private, and a system account's bare and readable
# arguments: name, uid, gid, home, login shell, kind (`user` or `system`)
oa_account_ensure() {
  if test "$#" -ne 6; then
    echo "oa_account_ensure needs a name, ids, a home, a shell and a kind" >&2
    return 1
  fi
  oa_account_name=$1
  oa_account_uid=$2
  oa_account_gid=$3
  oa_account_home=$4
  oa_account_shell=$5
  oa_account_kind=$6
  case $oa_account_name in
    '' | [!a-z_]* | *[!a-z0-9_-]*)
      echo "Refusing the account name $oa_account_name" >&2
      return 1
      ;;
  esac
  for oa_account_id in "$oa_account_uid" "$oa_account_gid"; do
    case $oa_account_id in
      '' | *[!0-9]* | 0 | 0?* | ??????????*)
        echo "Refusing $oa_account_name: $oa_account_id is not a non-root id" >&2
        return 1
        ;;
    esac
  done
  case $oa_account_home in
    /?*) ;;
    *)
      echo "Refusing $oa_account_name: its home $oa_account_home is not absolute" >&2
      return 1
      ;;
  esac
  case $oa_account_kind in
    system) oa_account_system=--system ;;
    user) oa_account_system= ;;
    *)
      echo "Refusing $oa_account_name: $oa_account_kind is not user or system" >&2
      return 1
      ;;
  esac
  if ! getent passwd "$oa_account_name" >/dev/null; then
    oa_account_create || return 1
  fi
  # the account's own group and the shared users group are the only ones it
  # may be in: another, such as sudo, disk, docker or shadow, can grant root's
  # powers, so it is refused rather than listed
  for oa_account_group in $(id -nG "$oa_account_name"); do
    case $oa_account_group in
      "$oa_account_name" | users) ;;
      *)
        echo "Refusing $oa_account_name: it is in the group $oa_account_group; only its own group and users are allowed" >&2
        return 1
        ;;
    esac
  done
  if test "$oa_account_kind" = system; then
    if test "$(id -u "$oa_account_name")" -gt 999; then
      echo "Refusing $oa_account_name: it exists with a user id that is not a system id" >&2
      return 1
    fi
    usermod --lock "$oa_account_name" || return 1
  fi
  oa_account_home=$(getent passwd "$oa_account_name" | cut -d: -f6)
  if ! test -d "$oa_account_home"; then
    oa_account_home_create || return 1
  fi
}

# creates the account oa_account_ensure was given, refusing ids another
# account or group holds
oa_account_create() {
  if test "$oa_account_kind" = system &&
    { test "$oa_account_uid" -gt 999 || test "$oa_account_gid" -gt 999; }; then
    echo "Refusing $oa_account_name: $oa_account_uid:$oa_account_gid are not system ids" >&2
    return 1
  fi
  if getent passwd "$oa_account_uid" >/dev/null; then
    echo "Refusing $oa_account_name: another account holds the user id $oa_account_uid" >&2
    return 1
  fi
  if oa_account_entry=$(getent group "$oa_account_name"); then
    if test "$(printf '%s' "$oa_account_entry" | cut -d: -f3)" != "$oa_account_gid"; then
      echo "Refusing $oa_account_name: its group exists under another id" >&2
      return 1
    fi
  elif getent group "$oa_account_gid" >/dev/null; then
    echo "Refusing $oa_account_name: another group holds the group id $oa_account_gid" >&2
    return 1
  else
    groupadd ${oa_account_system:+"$oa_account_system"} --gid "$oa_account_gid" "$oa_account_name" ||
      return 1
  fi
  useradd ${oa_account_system:+"$oa_account_system"} --uid "$oa_account_uid" \
    --gid "$oa_account_name" --home-dir "$oa_account_home" --no-create-home \
    --shell "$oa_account_shell" "$oa_account_name"
}

# creates the missing home of the account oa_account_ensure was given; a
# user's is filled from the skeleton while it is still root's and out of
# reach, then handed over and moved into place, so root never writes into a
# directory the account owns
oa_account_home_create() {
  oa_account_group_id=$(id -g "$oa_account_name") || return 1
  if test "$oa_account_kind" = system; then
    install -d -o "$oa_account_name" -g "$oa_account_group_id" -m 0755 "$oa_account_home"
    return
  fi
  rm -rf "$oa_account_home.open-agent-new" &&
    install -d -m 0700 "$oa_account_home.open-agent-new" || return 1
  if test -d /etc/skel; then
    cp -R /etc/skel/. "$oa_account_home.open-agent-new" || return 1
  fi
  chown -R "$oa_account_name:$oa_account_group_id" "$oa_account_home.open-agent-new" &&
    mv -T "$oa_account_home.open-agent-new" "$oa_account_home"
}

# sets a kernel parameter now and on every later boot when the kernel lets
# it; a guest that does not, such as a container, keeps going without it
# arguments: parameter, such as net.ipv4.ping_group_range, and its value
oa_sysctl() {
  case $1 in
    '' | [!a-z]* | *[!a-z0-9_.]*)
      echo "Refusing the kernel parameter $1" >&2
      return 1
      ;;
  esac
  case $2 in
    '' | *[!A-Za-z0-9\ ._-]*)
      echo "Refusing the value $2 of $1" >&2
      return 1
      ;;
  esac
  oa_sysctl_path=/proc/sys/$(printf '%s' "$1" | tr . /)
  if ! { printf '%s\n' "$2" >"$oa_sysctl_path"; } 2>/dev/null; then
    echo "The kernel parameter $1 cannot be set here; continuing without it" >&2
  fi
  if install -d -m 0755 /etc/sysctl.d 2>/dev/null; then
    { printf '%s = %s\n' "$1" "$2" >"/etc/sysctl.d/90-open-agent-$1.conf"; } 2>/dev/null || :
  fi
  return 0
}

# keeps a package's own service from ever starting, since open-agent runs its
# daemon itself: masks the vendor units and, through a policy-rc.d that
# refuses them alone, keeps a postinst from starting them where systemd is
# not running. A policy-rc.d another tool wrote is left as it is
# arguments: service units, such as tailscaled.service
oa_mask_service() {
  for oa_mask_unit; do
    case $oa_mask_unit in
      *.service) ;;
      *)
        echo "Refusing the service unit $oa_mask_unit: it is not a .service" >&2
        return 1
        ;;
    esac
    case ${oa_mask_unit%.service} in
      '' | [!A-Za-z0-9]* | *[!A-Za-z0-9@._-]*)
        echo "Refusing the service unit $oa_mask_unit" >&2
        return 1
        ;;
    esac
  done
  install -d -m 0755 /etc/systemd/system "${OA_MASKED_SERVICES%/*}" || return 1
  test -f "$OA_MASKED_SERVICES" || : >"$OA_MASKED_SERVICES" || return 1
  for oa_mask_unit; do
    ln -sfn /dev/null "/etc/systemd/system/$oa_mask_unit" || return 1
    if ! grep -qxF -- "${oa_mask_unit%.service}" "$OA_MASKED_SERVICES"; then
      printf '%s\n' "${oa_mask_unit%.service}" >>"$OA_MASKED_SERVICES" || return 1
    fi
  done
  oa_policy_rc_install || return 1
  if test -d /run/systemd/system; then
    systemctl daemon-reload || return 1
    for oa_mask_unit; do
      systemctl stop "$oa_mask_unit" 2>/dev/null || :
    done
  fi
}

# prints the policy-rc.d that refuses the masked services and allows the
# rest, and refuses every one while the updater holds them, which it tells
# through OA_POLICY_HOLD in the environment apt passes on
oa_policy_rc() {
  cat <<EOF
#!/bin/sh
$OA_POLICY_MARK
if test "\${OA_POLICY_HOLD-}" = 1; then
  exit 101
fi
if grep -qxF -- "\$1" $OA_MASKED_SERVICES 2>/dev/null; then
  exit 101
fi
exit 0
EOF
}

# writes open-agent's policy-rc.d, or rewrites it; a policy-rc.d another tool
# wrote is left as it is
oa_policy_rc_install() {
  if ! test -e "$OA_POLICY_RC" || test "$(sed -n 2p "$OA_POLICY_RC")" = "$OA_POLICY_MARK"; then
    oa_policy_rc >"$OA_POLICY_RC.new" && chmod 0755 "$OA_POLICY_RC.new" &&
      mv -f "$OA_POLICY_RC.new" "$OA_POLICY_RC" || return 1
  else
    echo "Keeping the policy-rc.d another tool wrote" >&2
  fi
}
