# open-agent's npm library, sourced as root after the OS family's library,
# whose oa_as it runs npm with: the agent installs its npm tools under its own
# global prefix with Homebrew's node, each kept at an npm dist-tag. The t3
# package downloads its runtime on its first run, so an install or update
# fetches it at once, and a cleanup removes the runtimes and the cached
# downloads of versions an update superseded

# the agent's global prefix and Homebrew's node
OA_NPM_PREFIX=$OA_AGENT_HOME/.local
OA_NPM_NODE=$OA_HOMEBREW_PREFIX/opt/node/bin
# npm's cache, which npm keeps in the agent's home by default
OA_NPM_CACHE=$OA_AGENT_HOME/.npm
# the T3 home the t3 package keeps its runtimes under: T3_HOME in
# src/drivers/agents/t3/service.ts, which the package finds from the agent's home
OA_NPM_T3_HOME=$OA_AGENT_HOME/.t3
# megabytes the volume needs free to fetch a T3 runtime: the download and its
# extraction are about 300 MB each
OA_NPM_PREFETCH_MIN_MB=1024
# seconds the fetch of a T3 runtime may take
OA_NPM_PREFETCH_SECONDS=900
# minutes after which a cached download counts as superseded, and after which
# a staging folder counts as left by an interrupted download
OA_NPM_CACHE_MINUTES=1440
OA_NPM_STAGING_MINUTES=60

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

# fetches the runtime the t3 package downloads on its first run, as the agent,
# so the first start after an install or update does not wait for ~300 MB: the
# package's wrapper keeps each version's runtime under the T3 home and
# downloads it when it is missing, and any run of it does that. It fetches
# nothing when the volume lacks room for the download and its extraction, and
# a failure only notes that the first start downloads it, since the package
# itself is installed
oa_npm_prefetch() {
  test -x "$OA_NPM_PREFIX/bin/t3" || return 0
  oa_prefetch_free=$(df -Pk "$OA_AGENT_HOME" 2>/dev/null |
    awk 'NR == 2 && $4 ~ /^[0-9]+$/ { print int($4 / 1024) }')
  if test -n "$oa_prefetch_free" && test "$oa_prefetch_free" -lt "$OA_NPM_PREFETCH_MIN_MB"; then
    echo "Not fetching the T3 runtime: $oa_prefetch_free MB are free on $OA_AGENT_HOME, which needs $OA_NPM_PREFETCH_MIN_MB MB" >&2
    return 0
  fi
  if ! oa_as agent env \
    PATH="$OA_NPM_PREFIX/bin:$OA_NPM_NODE:$OA_ACCOUNT_BASE_PATH" \
    T3CODE_HOME="$OA_NPM_T3_HOME" \
    timeout "$OA_NPM_PREFETCH_SECONDS" "$OA_NPM_PREFIX/bin/t3" --version >/dev/null; then
    echo "The T3 runtime could not be fetched; the first start downloads it" >&2
  fi
  return 0
}

# installs a package at its dist-tag under the agent's global prefix; the t3
# package's runtime is fetched along with it
# arguments: package name, dist-tag
oa_npm_install() {
  oa_npm_names "$1" "$2" || return 1
  oa_npm_run npm install --global --no-progress "$1@$2" || return 1
  if test "$1" = t3; then
    oa_npm_prefetch
  fi
}

# moves an installed package to the version its dist-tag names now; a current
# t3 package still has its runtime fetched when an earlier run could not
# arguments: package name, dist-tag
oa_npm_upgrade() {
  oa_npm_names "$1" "$2" || return 1
  if oa_npm_current "$1" "$2"; then
    if test "$1" = t3; then
      oa_npm_prefetch
    fi
    return 0
  fi
  oa_npm_install "$1" "$2"
}

# prints the directories a cleanup of the agent's npm tools shrinks
oa_npm_clean_roots() {
  printf '%s\n%s\n' "$OA_NPM_CACHE" "$OA_NPM_T3_HOME/runtime/versions"
}

# removes the downloads npm cached before the last day: what this update
# fetched is newer, and the tools it replaced were fetched by earlier runs,
# while every installed package already sits under the global prefix; npm then
# drops the index entries of what is gone
oa_npm_clean_cache() {
  test -d "$OA_NPM_CACHE/_cacache/content-v2" || return 0
  oa_as agent find "$OA_NPM_CACHE/_cacache/content-v2" -type f \
    -mmin "+$OA_NPM_CACHE_MINUTES" -delete || return 1
  oa_npm_run npm cache verify >/dev/null
}

# lists the T3 runtime versions some process runs from, one name a line
oa_npm_busy_runtimes() {
  for oa_busy_exe in /proc/[0-9]*/exe; do
    oa_busy_target=$(readlink "$oa_busy_exe" 2>/dev/null) || continue
    case $oa_busy_target in
      "$OA_NPM_T3_HOME/runtime/versions/"*)
        oa_busy_name=${oa_busy_target#"$OA_NPM_T3_HOME/runtime/versions/"}
        echo "${oa_busy_name%%/*}"
        ;;
    esac
  done
}

# removes the T3 runtime versions the installed t3 package no longer needs:
# every one but the installed version, the one installed before it, which
# stands for the newest other, and any a process runs from, and the staging
# folders an interrupted download left behind
oa_npm_clean_runtimes() {
  oa_runtimes_dir=$OA_NPM_T3_HOME/runtime/versions
  test -d "$oa_runtimes_dir" && ! test -L "$oa_runtimes_dir" || return 0
  oa_as agent find "$oa_runtimes_dir" -maxdepth 1 -type d -name '*.staging-*' \
    -mmin "+$OA_NPM_STAGING_MINUTES" -exec rm -rf {} + || return 1
  if ! oa_runtimes_installed=$(oa_npm_version t3 2>/dev/null) || test -z "$oa_runtimes_installed"; then
    echo "Keeping the T3 runtimes: the installed t3 version cannot be read"
    return 0
  fi
  oa_runtimes_busy=$(oa_npm_busy_runtimes)
  oa_runtimes_previous=
  oa_runtimes_status=0
  # the newest first, so the first one besides the installed version is the previous
  oa_runtimes_names=$(ls -1t "$oa_runtimes_dir")
  while IFS= read -r oa_runtimes_name; do
    case $oa_runtimes_name in
      '' | *[!A-Za-z0-9._+-]* | *.staging-*) continue ;;
    esac
    if ! test -d "$oa_runtimes_dir/$oa_runtimes_name" || test -L "$oa_runtimes_dir/$oa_runtimes_name"; then
      continue
    fi
    if test "$oa_runtimes_name" = "$oa_runtimes_installed"; then
      continue
    fi
    if test -z "$oa_runtimes_previous"; then
      oa_runtimes_previous=$oa_runtimes_name
      continue
    fi
    if printf '%s\n' "$oa_runtimes_busy" | grep -qxF "$oa_runtimes_name"; then
      continue
    fi
    echo "Removing the T3 runtime $oa_runtimes_name"
    oa_as agent rm -rf -- "$oa_runtimes_dir/$oa_runtimes_name" || oa_runtimes_status=1
  done <<EOF
$oa_runtimes_names
EOF
  return "$oa_runtimes_status"
}

# cleans up after an update of the agent's npm tools: the downloads npm kept of
# superseded versions and the T3 runtimes nothing needs. The tools that keep
# a copy per version of their own are the t3 package's runtimes alone: the
# claude and codex packages hold their binaries inside their own package. It
# returns 2, noting why on stderr, when npm is not there
oa_npm_clean() {
  if ! test -x "$OA_NPM_NODE/npm"; then
    echo 'Skipping the npm cleanup: npm is not installed' >&2
    return 2
  fi
  oa_clean_npm_status=0
  oa_npm_clean_cache || oa_clean_npm_status=1
  oa_npm_clean_runtimes || oa_clean_npm_status=1
  return "$oa_clean_npm_status"
}
