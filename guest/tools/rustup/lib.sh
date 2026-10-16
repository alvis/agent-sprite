# open-agent's rustup library, sourced as root after the OS family's library,
# whose oa_as it runs rustup with: the agent keeps its Rust toolchains in its
# own home with Homebrew's keg-only rustup, which never updates itself

# Homebrew's rustup
OA_RUSTUP_BIN=$OA_HOMEBREW_PREFIX/opt/rustup/bin

# runs rustup as the agent; asking for a version never fetches a toolchain
# arguments: rustup's arguments
oa_rustup() {
  oa_as agent env \
    PATH="$OA_RUSTUP_BIN:/usr/local/bin:/usr/bin:/bin" \
    RUSTUP_AUTO_INSTALL=0 \
    "$OA_RUSTUP_BIN/rustup" "$@"
}

# refuses a toolchain or component name rustup could read as an option
# arguments: names
oa_rustup_names() {
  for oa_names_rust; do
    case $oa_names_rust in
      '' | [!a-z0-9]* | *[!a-z0-9._-]*)
        echo "Refusing the Rust name $oa_names_rust" >&2
        return 1
        ;;
    esac
  done
}

# tells whether a toolchain and every named component are installed
# arguments: toolchain, then component names
oa_rustup_installed() {
  oa_rustup_names "$@" || return 1
  oa_installed_toolchain=$1
  shift
  oa_rustup toolchain list | grep -q "^$oa_installed_toolchain-" || return 1
  oa_installed_components=$(oa_rustup component list --installed --toolchain "$oa_installed_toolchain") ||
    return 1
  for oa_installed_component; do
    printf '%s\n' "$oa_installed_components" | grep -q "^$oa_installed_component\(-\|$\)" ||
      return 1
  done
}

# installs a toolchain with the minimal profile and the named components, and
# makes it the agent's default
# arguments: toolchain, then component names
oa_rustup_install() {
  oa_rustup_names "$@" || return 1
  oa_install_toolchain=$1
  shift
  oa_install_components=$(printf '%s,' "$@")
  oa_rustup toolchain install "$oa_install_toolchain" --profile minimal \
    --no-self-update ${oa_install_components:+--component "${oa_install_components%,}"} ||
    return 1
  oa_rustup default "$oa_install_toolchain"
}

# updates a toolchain and its components
# arguments: toolchain
oa_rustup_update() {
  oa_rustup_names "$1" || return 1
  oa_rustup update "$1" --no-self-update
}

# prints the version of a toolchain's compiler
# arguments: toolchain
oa_rustup_version() {
  oa_rustup_names "$1" || return 1
  oa_rustup run "$1" rustc --version
}
