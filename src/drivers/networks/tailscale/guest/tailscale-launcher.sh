#!/bin/sh
# Tailscale's launcher, run as root by the tailscaled service. It keeps the
# provider's resolvers and transport networks routed through the main table
# ahead of the tunnel, recording each rule it adds, and gives tailscaled a
# resolver file it may rewrite, then replaces itself with tailscaled.
# `--prepare` only prepares; `--restore <state directory>` undoes what a
# prepare recorded there. The resolver is replaced only while it is a regular
# file systemd-resolved does not manage; otherwise tailscaled configures
# resolved itself. It reads the daemon's directories, socket and tunnel, and
# the provider's transport networks, from environment.json, and finds ip and
# tailscaled on PATH

# no word the launcher splits is ever expanded as a glob
set -fu

OA_ENVIRONMENT=/opt/open-agent/environment.json
OA_RESOLVER=/etc/resolv.conf
# ahead of the rules tailscaled installs from 5210 on
OA_PRIORITY=5200
# the system's commands ahead of the tool links, which bring Homebrew's
# tailscaled: the Homebrew account is locked and root alone writes it
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin
export PATH
umask 022

# reports why the launcher stopped and exits non-zero
# arguments: the reason
oa_fail() {
  echo "tailscale launcher: $1" >&2
  exit 1
}

# names the files the launcher keeps in the state directory
# arguments: the state directory
oa_files() {
  oa_state=$1
  oa_managed=$oa_state/open-agent-resolv.conf
  oa_original=$oa_state/open-agent-provider-resolv.conf
  oa_rules=$oa_state/open-agent-transport-rules
}

# reads the daemon's state directory, socket and tunnel from environment.json
oa_load() {
  test -r "$OA_ENVIRONMENT" || oa_fail "$OA_ENVIRONMENT is not readable"
  oa_directory=$(/usr/bin/jq -er '.network.launcher.stateDirectory
      | select(type == "string" and startswith("/opt/open-agent/") and (contains("/../") | not))' \
    "$OA_ENVIRONMENT") || oa_fail "environment.json names no state directory"
  oa_socket=$(/usr/bin/jq -er '.network.launcher.socket
      | select(type == "string" and startswith("/") and (contains("/../") | not))' \
    "$OA_ENVIRONMENT") || oa_fail "environment.json names no daemon socket"
  oa_tun=$(/usr/bin/jq -er '.network.launcher.tun | select(type == "string" and test("^[a-z0-9][a-z0-9._-]*$"))' \
    "$OA_ENVIRONMENT") || oa_fail "environment.json names no tunnel"
  oa_files "$oa_directory"
}

# tells whether the active resolver is the managed file bound over it
oa_ours() {
  test -f "$oa_managed" && ! test -L "$OA_RESOLVER" && test -f "$OA_RESOLVER" &&
    test "$(stat -c '%d %i' "$OA_RESOLVER")" = "$(stat -c '%d %i' "$oa_managed")"
}

# tells whether the resolver may be replaced: a regular file systemd-resolved
# does not manage
oa_replaceable() {
  test -f "$OA_RESOLVER" && ! test -L "$OA_RESOLVER" &&
    ! grep -q 'systemd-resolved' "$OA_RESOLVER"
}

# prints a resolver file without its comments, leaving every directive as it is
# arguments: the file
oa_uncommented() {
  sed '/^[[:space:]]*#/d' "$1"
}

# tells whether the main-table rule for a destination is installed
# arguments: -4 or -6, the destination
oa_rule_installed() {
  oa_address=${2%%/*}
  # `ip rule show` omits the prefix length of a host destination
  oa_host=32
  test "$1" = -6 && oa_host=128
  oa_length=$oa_host
  case $2 in */*) oa_length=${2#*/} ;; esac
  ip "$1" -j rule show | /usr/bin/jq -e --argjson priority "$OA_PRIORITY" --arg dst "$oa_address" \
    --argjson length "$oa_length" --argjson host "$oa_host" '
    any(.[]; .priority == $priority and .dst == $dst
      and (.dstlen // $host) == $length and .table == "main")' >/dev/null
}

# routes one destination through the main table ahead of the tunnel and
# records the rule, so only the launcher removes it; a rule already installed
# is left alone and not recorded
# arguments: a host address or CIDR prefix
oa_rule_add() {
  case $1 in
    '' | *[!0-9A-Fa-f:./]* | */*/* | */)
      oa_fail "refusing the transport destination $1"
      ;;
  esac
  case $1 in */*[!0-9]*) oa_fail "refusing the transport destination $1" ;; esac
  oa_family=-4
  case ${1%%/*} in *:*) oa_family=-6 ;; esac
  if oa_rule_installed "$oa_family" "$1"; then
    return 0
  fi
  ip "$oa_family" rule add priority "$OA_PRIORITY" to "$1" lookup main ||
    oa_fail "could not route $1 outside the tunnel"
  if ! grep -qxF -- "$oa_family $1" "$oa_rules"; then
    printf '%s %s\n' "$oa_family" "$1" >>"$oa_rules"
  fi
}

# makes the directories, replaces a replaceable resolver with the managed
# copy, and routes the resolvers and transport networks outside the tunnel
oa_prepare() {
  command -v ip >/dev/null || oa_fail "ip is not on PATH"
  # a cold boot of a provider that discards its root filesystem loses the run
  # directory, and a first start has no state directory yet
  if ! { install -d -m 0700 "$oa_state" && chmod 0700 "$oa_state" &&
    install -d -m 0755 "${oa_socket%/*}" && chmod 0755 "${oa_socket%/*}"; }; then
    oa_fail "could not make the daemon's directories"
  fi
  if ! oa_ours && oa_replaceable && ! {
    cp "$OA_RESOLVER" "$oa_original" && chmod 0644 "$oa_original" &&
      oa_uncommented "$oa_original" >"$oa_managed" && chmod 0644 "$oa_managed" &&
      mount --bind "$oa_managed" "$OA_RESOLVER"
  }; then
    oa_fail "could not hand tailscaled a resolver it may rewrite"
  fi
  # written in place, keeping the inode the bind mount holds
  if oa_ours && ! {
    oa_resolver=$(oa_uncommented "$oa_managed") &&
      printf '%s\n' "$oa_resolver" >"$oa_managed"
  }; then
    oa_fail "could not rewrite the managed resolver"
  fi
  if ! { touch "$oa_rules" && chmod 0600 "$oa_rules"; }; then
    oa_fail "could not record the transport rules"
  fi
  # the provider's resolvers, as they were before tailscaled could rewrite
  # them; a resolver systemd-resolved manages is local and needs no rule
  oa_nameservers=
  if oa_ours; then
    oa_nameservers=$(sed -n \
      's/^[[:space:]]*nameserver[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' "$oa_original")
  fi
  for oa_nameserver in $oa_nameservers; do
    oa_rule_add "$oa_nameserver"
  done
  oa_networks=$(/usr/bin/jq -er '.provider.transportNetworks | select(type == "array") | .[] | strings' \
    "$OA_ENVIRONMENT") || oa_networks=
  for oa_network in $oa_networks; do
    oa_rule_add "$oa_network"
  done
}

# releases the resolver when it is the managed copy and removes every rule a
# prepare recorded that is still installed
oa_restore() {
  if oa_ours; then
    umount "$OA_RESOLVER" || oa_fail "could not release $OA_RESOLVER"
  fi
  test -f "$oa_rules" || return 0
  while read -r oa_family oa_destination oa_rest; do
    case $oa_family in -4 | -6) ;; *) oa_fail "a recorded transport rule is malformed" ;; esac
    if test -z "${oa_destination-}" || test -n "${oa_rest-}"; then
      oa_fail "a recorded transport rule is malformed"
    fi
    # a cold boot drops the kernel's rules but keeps the record
    if oa_rule_installed "$oa_family" "$oa_destination"; then
      ip "$oa_family" rule del priority "$OA_PRIORITY" to "$oa_destination" lookup main ||
        oa_fail "could not remove the rule for $oa_destination"
    fi
  done <"$oa_rules"
  : >"$oa_rules"
}

# replaces the launcher with tailscaled, so the service supervises it directly
oa_supervise() {
  oa_daemon=$(command -v tailscaled) || oa_fail "tailscaled is not on PATH"
  exec "$oa_daemon" --state="$oa_state/tailscaled.state" --socket="$oa_socket" \
    --tun="$oa_tun"
}

case ${1-} in
  --restore)
    case ${2-} in
      */../* | */..) oa_fail "--restore needs the daemon's state directory" ;;
      /opt/open-agent/?*) ;;
      *) oa_fail "--restore needs the daemon's state directory" ;;
    esac
    oa_files "$2"
    oa_restore
    ;;
  --prepare)
    oa_load
    oa_prepare
    ;;
  '')
    oa_load
    oa_prepare
    oa_supervise
    ;;
  *) oa_fail "unknown argument $1" ;;
esac
