#!/bin/sh
set -eu

export PATH=/usr/sbin:/usr/bin:/sbin:/bin

umask 022
install -m 0600 /dev/null /opt/agent-sprite/install-tools.log
exec > /opt/agent-sprite/install-tools.log 2>&1

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
apt-get install -y -qq --no-upgrade --no-install-recommends ca-certificates curl jq tar xz-utils

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
install -d -m 0755 /opt/agent-sprite /opt/agent-sprite/node
architecture="$(uname -m)"
case "$architecture" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) exit 30 ;;
esac

printf '%s\n' 'Installing Node'
node_version="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.version | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))][0].version')"
test "$node_version" != null
node_archive="node-${node_version}-linux-${node_arch}.tar.xz"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
curl -fsSL "https://nodejs.org/dist/${node_version}/${node_archive}" -o "$temporary/$node_archive"
curl -fsSL "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o "$temporary/SHASUMS256.txt"
(cd "$temporary" && grep "  ${node_archive}$" SHASUMS256.txt | sha256sum -c -)
rm -rf /opt/agent-sprite/node
mkdir -p /opt/agent-sprite/node
tar -xJf "$temporary/$node_archive" -C /opt/agent-sprite/node --strip-components=1 --no-same-owner
ln -sfn /opt/agent-sprite/node/bin/node /usr/local/bin/node
ln -sfn /opt/agent-sprite/node/bin/npm /usr/local/bin/npm
ln -sfn /opt/agent-sprite/node/bin/npx /usr/local/bin/npx
