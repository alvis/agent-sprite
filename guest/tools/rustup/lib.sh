# open-agent's rustup library, sourced as root after the OS family's library,
# whose oa_as it runs rustup with: the agent keeps its Rust toolchains in its
# own home with Homebrew's keg-only rustup, which never updates itself

# Homebrew's rustup
OA_RUSTUP_BIN=$OA_HOMEBREW_PREFIX/opt/rustup/bin
# rustup's home, where it keeps toolchains, downloads and temporary files; it
# is the agent's .rustup unless RUSTUP_HOME says otherwise, which nothing sets
OA_RUSTUP_HOME=$OA_AGENT_HOME/.rustup
# minutes after which a download or temporary file counts as left over
OA_RUSTUP_LEFTOVER_MINUTES=60

# runs rustup as the agent; asking for a version never fetches a toolchain
# arguments: rustup's arguments
oa_rustup() {
  oa_as agent env \
    PATH="$OA_RUSTUP_BIN:$OA_ACCOUNT_BASE_PATH" \
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

# prints the directories a cleanup of rustup shrinks: where it keeps downloads
# in progress and its temporary files
oa_rustup_clean_roots() {
  printf '%s\n%s\n' "$OA_RUSTUP_HOME/downloads" "$OA_RUSTUP_HOME/tmp"
}

# cleans up after an update of the toolchains: the downloads and temporary
# files an interrupted update left, once they are an hour old. Never a
# toolchain, which lives under toolchains/ and is not touched. It returns 2,
# noting why on stderr, when rustup is not installed
oa_rustup_clean() {
  if ! test -x "$OA_RUSTUP_BIN/rustup"; then
    echo 'Skipping the rustup cleanup: rustup is not installed' >&2
    return 2
  fi
  for oa_clean_rustup_dir in downloads tmp; do
    if ! test -d "$OA_RUSTUP_HOME/$oa_clean_rustup_dir" || test -L "$OA_RUSTUP_HOME/$oa_clean_rustup_dir"; then
      continue
    fi
    oa_as agent find "$OA_RUSTUP_HOME/$oa_clean_rustup_dir" -mindepth 1 -mmin "+$OA_RUSTUP_LEFTOVER_MINUTES" \
      -delete 2>/dev/null || :
  done
}
