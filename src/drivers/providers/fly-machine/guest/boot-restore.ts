// the boot script's root filesystem steps: packages from the volume's apt
// cache, the installer's recorded links, the login profile and the machine label

import { TOOL_LINK_DIRECTORY, TOOL_LINK_RECORD } from '#guest/homebrew';
import {
  MACHINE_INFO_LABEL_KEY,
  MACHINE_INFO_PATH,
  WORKSTATION_NAME_RECORD,
} from '#guest/workstation-label';

import {
  APT_CONFIGURATION,
  BOOT_SCRIPT_PATH,
  IMAGE_APT_CLEANER,
  PROFILE_PATH,
  UNUSED_PACKAGES,
  VOLUME_LAYOUT,
} from './boot-paths.js';

/**
 * the steps that keep apt's lists and downloads on the volume and reinstall the recorded packages
 * @returns the section's text
 */
export function aptSection(): string {
  return `# keeps apt's package lists and downloads on the volume, and records what is
# installed after every dpkg call
configure_apt() {
  rm -f ${IMAGE_APT_CLEANER}
  cat >${APT_CONFIGURATION}.new <<'APT'
Binary::apt::APT::Keep-Downloaded-Packages "true";
APT::Keep-Downloaded-Packages "true";
DPkg::Post-Invoke { "/bin/sh ${BOOT_SCRIPT_PATH} record-packages || true"; };
APT
  mv -f ${APT_CONFIGURATION}.new ${APT_CONFIGURATION}
  install -d -m 0755 "${VOLUME_LAYOUT.apt}" "${VOLUME_LAYOUT.apt}/lists" "${VOLUME_LAYOUT.apt}/archives"
  is_root_only "${VOLUME_LAYOUT.apt}" || { echo "${VOLUME_LAYOUT.apt} is not root's alone"; return 1; }
  bind "${VOLUME_LAYOUT.apt}/lists" /var/lib/apt/lists || return 1
  bind "${VOLUME_LAYOUT.apt}/archives" /var/cache/apt/archives
}

# installs the recorded packages from the volume's cache, without updating
# the package lists; a package the cache lacks is downloaded and kept
install_packages() {
  if ! test -s "$record"; then
    echo "No packages are recorded yet"
    return 0
  fi
  packages=$(grep -Ex '[a-z0-9][a-z0-9.+-]*' "$record" | grep -vxF${UNUSED_PACKAGES.map((name) => ` -e ${name}`).join('')} | tr '\\n' ' ')
  if test -z "$packages"; then
    return 0
  fi
  echo "Installing $packages"
  # the root filesystem is discarded at the next stop, so dpkg skips its fsyncs
  apt-get install -y -qq --no-upgrade --no-install-recommends -o Dpkg::Options::=--force-unsafe-io $packages
}

# points a path at its target, replacing a stale link in one rename
link() {
  if test "$(readlink "$2" 2>/dev/null || true)" = "$1"; then
    return 0
  fi
  pending="$(dirname "$2")/.$(basename "$2").open-agent.$$"
  ln -s "$1" "$pending" && mv -T "$pending" "$2"
}`;
}

/**
 * the steps that restore the recorded links in /usr/local/bin and the login profile
 * @returns the section's text
 */
export function linkSection(): string {
  return `# restores every link the installer recorded in /usr/local/bin, so a tool
# added to the installer needs no new boot script. A record that is a link or
# not root's alone is refused; a line is restored only when its path is
# directly in /usr/local/bin under a safe name and its target is an absolute
# path that exists, and any other line is skipped. Before the installer has
# recorded a link there is nothing to restore
restore_links() {
  link_record=${TOOL_LINK_RECORD}
  if ! test -e "$link_record"; then
    echo "No links are recorded yet"
    return 0
  fi
  if ! test -f "$link_record" || test -L "$link_record" || \\
      test "$(stat -c %u "$link_record")" != 0 || \\
      test $((0$(stat -c %a "$link_record") & 022)) -ne 0; then
    echo "Refusing $link_record: it is not a file or not root's alone"
    return 1
  fi
  tab=$(printf '\\t')
  while IFS="$tab" read -r link_path link_target || test -n "$link_path"; do
    test -n "$link_path" || continue
    if test "$(dirname "$link_path")" != "${TOOL_LINK_DIRECTORY}" || \\
        ! printf '%s\\n' "$(basename "$link_path")" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9._+-]*'; then
      echo "Skipping $link_path: not a command directly in ${TOOL_LINK_DIRECTORY}"
      continue
    fi
    case "$link_target" in
      /*) ;;
      *) echo "Skipping $link_path: $link_target is not an absolute path"; continue ;;
    esac
    if ! test -e "$link_target"; then
      echo "Skipping $link_path: $link_target does not exist"
      continue
    fi
    link "$link_target" "$link_path" || return 1
  done <"$link_record"
}

# puts the managed tools and an account's own commands on every login shell's
# PATH, in the order the installer runs them
write_profile() {
  cat >${PROFILE_PATH}.new <<'PROFILE'
# open-agent: the managed tools and, for an ordinary account, its own commands
case ":$PATH:" in
  *:/usr/local/bin:*) ;;
  *) PATH="/usr/local/bin:$PATH" ;;
esac
if test "$(id -u)" != 0 && test -d "$HOME/.local/bin"; then
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) PATH="$HOME/.local/bin:$PATH" ;;
  esac
fi
export PATH
PROFILE
  chmod 0644 ${PROFILE_PATH}.new && mv -f ${PROFILE_PATH}.new ${PROFILE_PATH}
}`;
}

/**
 * the step that recreates the machine information file, whose label the agent shows as its environment name, from the workstation name recorded on the volume
 * @returns the section's text
 */
export function labelSection(): string {
  return `# recreates the machine information file from the workstation name the
# installer recorded under the guest root, keeping any other key the file has;
# a boot before the installer has recorded a name has nothing to restore, and a
# record that is not root's alone or not a DNS label is refused
restore_label() {
  label_record=${WORKSTATION_NAME_RECORD}
  if ! test -f "$label_record"; then
    echo "No workstation name is recorded yet"
    return 0
  fi
  if test -L "$label_record" || test "$(stat -c %u "$label_record")" != 0 || \\
      test $((0$(stat -c %a "$label_record") & 022)) -ne 0; then
    echo "Refusing $label_record: it is a link or not root's alone"
    return 1
  fi
  workstation=$(head -n 1 "$label_record")
  if ! printf '%s\\n' "$workstation" | grep -Eqx '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'; then
    echo "Refusing $label_record: it does not hold a DNS label"
    return 1
  fi
  {
    if test -f ${MACHINE_INFO_PATH}; then
      grep -v '^[[:space:]]*${MACHINE_INFO_LABEL_KEY}[[:space:]]*=' ${MACHINE_INFO_PATH} || true
    fi
    printf '${MACHINE_INFO_LABEL_KEY}=%s\\n' "$workstation"
  } >${MACHINE_INFO_PATH}.new || return 1
  chmod 0644 ${MACHINE_INFO_PATH}.new && mv -f ${MACHINE_INFO_PATH}.new ${MACHINE_INFO_PATH}
}`;
}
