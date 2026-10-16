# open-agent's npm library, sourced as root after the OS family's library,
# whose oa_as it runs npm with: the agent installs its npm tools under its own
# global prefix with Homebrew's node, each kept at an npm dist-tag

# the agent's global prefix and Homebrew's node
OA_NPM_PREFIX=$OA_AGENT_HOME/.local
OA_NPM_NODE=$OA_HOMEBREW_PREFIX/opt/node/bin

# runs one of Homebrew node's programs as the agent, with the agent's global
# prefix and without npm's notices
# arguments: program (node or npm), then its arguments
oa_npm_run() {
  oa_npm_program=$1
  shift
  oa_as agent env \
    PATH="$OA_NPM_PREFIX/bin:$OA_NPM_NODE:$OA_ACCOUNT_BASE_PATH" \
    NPM_CONFIG_PREFIX="$OA_NPM_PREFIX" \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    "$OA_NPM_NODE/$oa_npm_program" "$@"
}

# refuses a package name or dist-tag npm could read as an option or a path
# arguments: package name, dist-tag
oa_npm_names() {
  case $1 in
    '' | [!a-z0-9@]* | *[!a-z0-9@/._~-]* | *..*)
      echo "Refusing the npm package $1" >&2
      return 1
      ;;
  esac
  case $2 in
    '' | [!A-Za-z0-9]* | *[!A-Za-z0-9._-]*)
      echo "Refusing the npm dist-tag $2" >&2
      return 1
      ;;
  esac
}

# prints the version of a package installed under the agent's global prefix
# arguments: package name
oa_npm_version() {
  oa_npm_names "$1" latest || return 1
  test -f "$OA_NPM_PREFIX/lib/node_modules/$1/package.json" || return 1
  oa_npm_run node -p 'require(process.argv[1]).version' \
    "$OA_NPM_PREFIX/lib/node_modules/$1/package.json"
}

# tells whether the installed version of a package is the one its dist-tag
# names now
# arguments: package name, dist-tag
oa_npm_current() {
  oa_npm_names "$1" "$2" || return 1
  oa_current_installed=$(oa_npm_version "$1") || return 1
  oa_current_tagged=$(oa_npm_run npm view "$1@$2" version) || return 1
  test -n "$oa_current_tagged" && test "$oa_current_installed" = "$oa_current_tagged"
}

# installs a package at its dist-tag under the agent's global prefix
# arguments: package name, dist-tag
oa_npm_install() {
  oa_npm_names "$1" "$2" || return 1
  oa_npm_run npm install --global --no-progress "$1@$2"
}

# moves an installed package to the version its dist-tag names now
# arguments: package name, dist-tag
oa_npm_upgrade() {
  oa_npm_names "$1" "$2" || return 1
  if oa_npm_current "$1" "$2"; then
    return 0
  fi
  oa_npm_install "$1" "$2"
}
