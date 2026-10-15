#!/bin/sh
set -eu

export PATH=/usr/sbin:/usr/bin:/sbin:/bin

# the guest root is passed by the transaction launcher, which takes it from
# src/guest/guest-root.ts; this shell cannot import it
root="${1:?guest root required}"

umask 022
install -m 0600 /dev/null $root/install-tools.log
exec > $root/install-tools.log 2>&1

# an outcomes file from an earlier run must never be read as this run's
outcomes="$root/install-outcomes.json"
rm -f "$outcomes" "$outcomes.new"

# what this run did to open-agent's private Node, recorded on every exit once
# the Node gate began as the guest-node component, since the node component is
# Homebrew's; the install-tools process that follows adds the other components
# to it. The private Node is never linked into /usr/local/bin: open-agent's
# own code runs it by its path, and the user's node, npm and npx are Homebrew's
gate=0
node_status=failed
node_version=
node_error='install failed'
staging=
swapped=0
temporary=

finish() {
  code=$?
  set +e
  trap - EXIT
  if test -n "$staging" && test "$swapped" != 1; then
    rm -rf "$staging"
  fi
  if test -n "$temporary"; then
    rm -rf "$temporary"
  fi
  if test "$gate" = 1; then
    if test "$code" -eq 0 && test "$node_status" != failed; then
      printf '{\n  "guest-node": {"status": "%s", "version": "%s"}\n}\n' \
        "$node_status" "$node_version" >"$outcomes.new"
    else
      printf '{\n  "guest-node": {"status": "failed", "error": "%s"}\n}\n' \
        "$node_error" >"$outcomes.new"
    fi
    mv -f "$outcomes.new" "$outcomes"
  fi
  exit "$code"
}
trap finish EXIT
# a signal ends the script through the exit trap, so a terminated run still
# records what it did to Node
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# tells whether a process runs a binary that lives inside a tree
tree_in_use() {
  for exe in /proc/[0-9]*/exe; do
    case "$(readlink "$exe" 2>/dev/null || true)" in
      "$1"/*) return 0 ;;
    esac
  done
  return 1
}

# removes the Node trees that are neither kept nor running a process: a service
# that was never restarted still runs from the tree it started from
prune_trees() {
  for tree in "$root"/node-v*.*; do
    if ! test -d "$tree"; then
      continue
    fi
    name="$(basename "$tree")"
    if test "$name" = "$1" || test "$name" = "$2"; then
      continue
    fi
    if tree_in_use "$tree"; then
      continue
    fi
    rm -rf "$tree"
  done
}

export DEBIAN_FRONTEND=noninteractive
if ! test -f /etc/os-release; then
  exit 31
fi
. /etc/os-release
case "${ID:-}" in
  debian|ubuntu) ;;
  *) exit 32 ;;
esac
apt-get update -qq
apt-get install -y -qq --no-upgrade --no-install-recommends ca-certificates curl jq libatomic1 tar xz-utils

if ! getent passwd agent >/dev/null; then
  native_home_mode="$(stat -c %a /home)"
  if test -L /home || test "$(stat -c %u /home)" != 0 || \
      test "$((0$native_home_mode & 022))" -ne 0 || \
      test -e /home/agent || test -L /home/agent; then
    printf '%s\n' 'Refusing to create an account over an existing or linked home' >&2
    exit 35
  fi
  useradd --create-home --shell /bin/bash agent
fi
install -d -m 0755 "$root"
architecture="$(uname -m)"
case "$architecture" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) exit 30 ;;
esac

gate=1
node_error='latest version could not be resolved'
# staging and link names left by a run that was killed before its cleanup
rm -f "$root"/.node-link.*
current="$(basename "$(readlink "$root/node" 2>/dev/null || true)")"
prune_trees "$current" "$current"
printf '%s\n' 'Resolving the latest Node release'
node_version="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.version | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))][0].version')"
if ! printf '%s' "$node_version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  node_version=
  exit 33
fi

# the installed Node is judged by its own binary, and npm must run on it too,
# so a tree whose npm is broken is installed again
installed_version="$("$root/node/bin/node" --version 2>/dev/null || true)"
if test "$installed_version" = "$node_version" && \
    PATH="$root/node/bin:$PATH" "$root/node/bin/npm" --version >/dev/null 2>&1; then
  printf '%s\n' "Node $node_version is already installed"
  node_status=skipped
  node_version="${node_version#v}"
  exit 0
fi

node_error='install failed'
printf '%s\n' "Installing Node $node_version"
node_archive="node-${node_version}-linux-${node_arch}.tar.xz"
temporary="$(mktemp -d)"
curl -fsSL "https://nodejs.org/dist/${node_version}/${node_archive}" -o "$temporary/$node_archive"
curl -fsSL "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o "$temporary/SHASUMS256.txt"
(cd "$temporary" && grep "  ${node_archive}$" SHASUMS256.txt | sha256sum -c -)

# the new tree is built beside the live one and put in place with one rename;
# the live tree is never deleted while it may be running
staging="$(mktemp -d "$root/node-${node_version}.XXXXXX")"
chmod 0755 "$staging"
tar -xJf "$temporary/$node_archive" -C "$staging" --strip-components=1 --no-same-owner
test "$("$staging/bin/node" --version)" = "$node_version"

previous="$(basename "$(readlink "$root/node" 2>/dev/null || true)")"
pending="$(mktemp -u "$root/.node-link.XXXXXX")"
ln -s "$(basename "$staging")" "$pending"
mv -T "$pending" "$root/node"
swapped=1

# only the new tree and the one it replaced remain, unless a process still
# runs from another; the replaced tree may be running this very process
prune_trees "$(basename "$staging")" "$previous"

node_status=installed
node_version="${node_version#v}"
