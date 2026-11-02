# open-agent's Homebrew library, sourced as root after the OS family's
# library, whose oa_as it runs brew with: Homebrew lives at the default
# prefix, the only one bottles pour at, owned by the linuxbrew system account,
# runs the release setup pins, and every formula is poured from its bottle,
# never built from source

# the prefix's account, home and brew
OA_BREW_ACCOUNT=linuxbrew
OA_BREW_HOME=$OA_LINUXBREW_HOME
OA_BREW_PREFIX=$OA_HOMEBREW_PREFIX
OA_BREW=$OA_BREW_PREFIX/bin/brew
# the git checkout Homebrew runs from
OA_BREW_REPOSITORY=$OA_BREW_PREFIX/Homebrew
# the status a brew function returns when a formula has no bottle for the guest
OA_NO_BOTTLE_STATUS=78

# runs a command as the prefix's account in brew's fixed environment: brew
# never updates itself unasked, never reports analytics and never builds a
# missing bottle
# arguments: further variables as NAME=VALUE, then the command
oa_brew_as() {
  oa_as "$OA_BREW_ACCOUNT" env -i \
    HOME="$OA_BREW_HOME" USER="$OA_BREW_ACCOUNT" LOGNAME="$OA_BREW_ACCOUNT" \
    LANG=C.UTF-8 \
    PATH="$OA_HOMEBREW_PATH:$OA_SYSTEM_PATH" \
    HOMEBREW_NO_AUTO_UPDATE=1 \
    HOMEBREW_NO_ANALYTICS=1 \
    HOMEBREW_NO_ENV_HINTS=1 \
    HOMEBREW_NO_BOTTLE_SOURCE_FALLBACK=1 \
    "$@"
}

# runs brew as the prefix's account in its fixed environment
# arguments: brew's arguments
oa_brew() {
  oa_brew_as "$OA_BREW" "$@"
}

# runs the system's git in Homebrew's checkout as the prefix's account
# arguments: git's arguments
oa_brew_git() {
  oa_brew_as /usr/bin/git -C "$OA_BREW_REPOSITORY" "$@"
}

# tells whether Homebrew is installed at its prefix, owned by its account
oa_homebrew_installed() {
  test -x "$OA_BREW" &&
    test "$(stat -c %U "$OA_BREW_PREFIX")" = "$OA_BREW_ACCOUNT" &&
    oa_brew --version >/dev/null
}

# installs Homebrew at its default prefix from the official installer, pinned
# by its digest, run non-interactively as the prefix's account, which owns the
# prefix beforehand and so needs no sudo
# arguments: installer URL, its sha256
oa_homebrew_install() {
  if oa_homebrew_installed; then
    return 0
  fi
  if ! getent passwd "$OA_BREW_ACCOUNT" >/dev/null; then
    echo "Homebrew needs the $OA_BREW_ACCOUNT account first" >&2
    return 1
  fi
  install -d -o "$OA_BREW_ACCOUNT" -g "$(id -g "$OA_BREW_ACCOUNT")" -m 0755 \
    "$OA_BREW_HOME" "$OA_BREW_PREFIX" || return 1
  oa_homebrew_work=$(mktemp -d) || return 1
  oa_homebrew_run "$oa_homebrew_work" "$1" "$2"
  oa_homebrew_status=$?
  rm -rf "$oa_homebrew_work"
  test "$oa_homebrew_status" -eq 0 || return "$oa_homebrew_status"
  oa_homebrew_installed
}

# downloads the installer into a work directory, checks its digest and runs it
# arguments: work directory, installer URL, its sha256
oa_homebrew_run() {
  chmod 0755 "$1" || return 1
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --max-time 300 \
    -o "$1/install.sh" "$2" || return 1
  if test "$(sha256sum "$1/install.sh" | cut -d ' ' -f 1)" != "$3"; then
    echo "Refusing the Homebrew installer at $2: its digest is not the pinned one" >&2
    return 1
  fi
  chmod 0644 "$1/install.sh" || return 1
  oa_as "$OA_BREW_ACCOUNT" env -i \
    HOME="$OA_BREW_HOME" USER="$OA_BREW_ACCOUNT" LOGNAME="$OA_BREW_ACCOUNT" \
    LANG=C.UTF-8 PATH="$OA_SYSTEM_PATH" \
    NONINTERACTIVE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_AUTO_UPDATE=1 \
    /bin/bash "$1/install.sh"
}

# tells whether Homebrew runs a release: its checkout is at the release's
# commit
# arguments: the release's commit
oa_homebrew_pinned() {
  test "$(oa_brew_git rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null)" = "$1"
}

# checks out a Homebrew release in place of the newest one the installer
# leaves, or an earlier release, once its tag, fetched afresh, names the
# release's commit; nothing but this moves Homebrew's own code
# arguments: the release's tag, its commit
oa_homebrew_pin() {
  case $1 in
    '' | [!0-9]* | *[!0-9.]*)
      echo "Refusing the Homebrew release $1" >&2
      return 1
      ;;
  esac
  case $2 in
    *[!0-9a-f]*)
      echo "Refusing the Homebrew commit $2" >&2
      return 1
      ;;
  esac
  test "${#2}" -eq 40 || {
    echo "Refusing the Homebrew commit $2" >&2
    return 1
  }
  ! oa_homebrew_pinned "$2" || return 0
  oa_brew_git fetch --quiet --force --no-tags origin "+refs/tags/$1:refs/tags/$1" || return 1
  if test "$(oa_brew_git rev-parse --verify --quiet "refs/tags/$1^{commit}")" != "$2"; then
    echo "Refusing Homebrew $1: its tag does not name the pinned commit $2" >&2
    return 1
  fi
  oa_brew_git checkout --quiet --force -B stable "$2" || return 1
  oa_homebrew_pinned "$2"
}

# refuses a formula or tap name brew could read as an option
# arguments: names
oa_brew_names() {
  for oa_names_formula; do
    case $oa_names_formula in
      '' | [!a-z0-9]* | *[!a-z0-9@._+/-]*)
        echo "Refusing the formula $oa_names_formula" >&2
        return 1
        ;;
    esac
  done
}

# names the bottle tag of the guest's architecture
oa_brew_tag() {
  case $(uname -m) in
    x86_64 | amd64) echo x86_64_linux ;;
    aarch64 | arm64) echo arm64_linux ;;
    *)
      echo "Homebrew has no bottles for $(uname -m)" >&2
      return 1
      ;;
  esac
}

# prints `no-bottle:<formula>` for every named formula that, or one of whose
# runtime dependencies, has no bottle for the guest's architecture
# arguments: formula names
oa_brew_unbottled() {
  oa_brew_names "$@" || return 1
  oa_unbottled_tag=$(oa_brew_tag) || return 1
  oa_unbottled_deps=$(oa_brew deps --for-each "$@") || return 1
  # every formula and dependency, one per line, for brew info
  oa_unbottled_all=$(printf '%s\n' "$oa_unbottled_deps" | tr -d ':' | tr ' ' '\n' | sort -u)
  set --
  while IFS= read -r oa_unbottled_name; do
    test -z "$oa_unbottled_name" || set -- "$@" "$oa_unbottled_name"
  done <<EOF
$oa_unbottled_all
EOF
  oa_unbottled_missing=$(oa_brew info --json=v2 "$@" | oa_brew ruby -e "
    require 'json'
    JSON.parse(STDIN.read).fetch('formulae').each do |formula|
      files = formula.dig('bottle', 'stable', 'files') || {}
      puts formula.fetch('name') unless files.key?('$oa_unbottled_tag') || files.key?('all')
    end
  ") || return 1
  printf '%s\n' "$oa_unbottled_deps" | awk -v missing="$oa_unbottled_missing" '
    BEGIN { count = split(missing, names, "\n"); for (i = 1; i <= count; i++) absent[names[i]] = 1 }
    {
      formula = $1
      sub(/:$/, "", formula)
      refused = (formula in absent)
      for (i = 2; i <= NF; i++) if ($i in absent) refused = 1
      if (refused) print "no-bottle:" formula
    }'
}

# tells whether a formula is installed
# arguments: formula name
oa_brew_installed() {
  oa_brew_names "$1" || return 1
  oa_brew list --formula --versions "$1" >/dev/null 2>&1
}

# installs a formula from its bottle, tapping its tap first; a formula that,
# or one of whose dependencies, has no bottle for the guest is refused with
# status 78, so setup can fall through to the tool's next source
# arguments: formula name, then its tap when it is not homebrew/core
oa_brew_install() {
  oa_brew_names "$@" || return 1
  if test "$#" -gt 1; then
    oa_brew tap "$2" || return 1
  fi
  if oa_brew_installed "$1"; then
    return 0
  fi
  oa_install_unbottled=$(oa_brew_unbottled "$1") || return 1
  if test -n "$oa_install_unbottled"; then
    printf '%s\n' "$oa_install_unbottled"
    echo "Refusing $1: Homebrew has no bottle of it or a dependency for $(uname -m)" >&2
    return "$OA_NO_BOTTLE_STATUS"
  fi
  oa_brew install --formula "$1"
}

# refreshes Homebrew's formula data from its API, leaving its own code at
# the pinned release: `brew update` would move that to the newest tag, so it
# never runs, and an `outdated` run fetches the data in its stead, which it
# does even with automatic updates off when asked to; it prints the installed
# formulae the refreshed data has a newer version of, one name a line
oa_brew_refresh() {
  oa_brew_as HOMEBREW_FORCE_API_AUTO_UPDATE=1 "$OA_BREW" outdated --formula --quiet
}

# upgrades installed formulae from their bottles; one whose new version has no
# bottle for the guest yet keeps its current version
# arguments: formula names
oa_brew_upgrade() {
  oa_brew_names "$@" || return 1
  oa_upgrade_unbottled=$(oa_brew_unbottled "$@") || return 1
  for oa_upgrade_formula; do
    shift
    if printf '%s\n' "$oa_upgrade_unbottled" | grep -qxF "no-bottle:$oa_upgrade_formula"; then
      echo "Keeping $oa_upgrade_formula: its new version has no bottle for $(uname -m)" >&2
    elif oa_brew_installed "$oa_upgrade_formula"; then
      set -- "$@" "$oa_upgrade_formula"
    fi
  done
  test "$#" -eq 0 || oa_brew upgrade --formula "$@"
}

# prints the installed version of a formula
# arguments: formula name
oa_brew_version() {
  oa_brew_names "$1" || return 1
  oa_brew list --formula --versions "$1" | cut -d ' ' -f 2
}

# lists every installed formula with its versions, one formula a line, as
# `brew list --formula --versions` prints them: one brew run in place of one
# a formula; the caller takes it afresh after anything changed the formulae
# and never keeps it beyond its own run
oa_brew_listing() {
  oa_brew list --formula --versions
}

# prints the installed version of a formula from a listing
# oa_brew_listing printed, asking brew for the formula alone when the listing
# cannot name it exactly: a tap's formula, whose listed short name another
# formula may share, an alias, which the listing names by its formula, or a
# formula the listing misses
# arguments: the listing's file, formula name
oa_brew_listed_version() {
  oa_brew_names "$2" || return 1
  case $2 in
    */*) ;;
    *)
      oa_listed_version=$(awk -v name="$2" '$1 == name { print $2; exit }' "$1" 2>/dev/null)
      if test -n "$oa_listed_version"; then
        echo "$oa_listed_version"
        return 0
      fi
      ;;
  esac
  oa_brew_version "$2"
}

# prints the directories a cleanup of Homebrew shrinks: the formulae's kegs
# and the account's download cache
oa_brew_clean_roots() {
  printf '%s\n%s\n' "$OA_BREW_PREFIX/Cellar" "$OA_BREW_HOME/.cache/Homebrew"
}

# cleans up after an update of the formulae: brew removes the kegs of versions
# an upgrade replaced and the downloads of superseded bottles, keeps every
# installed formula's current keg and any pinned one, and expires cached
# downloads after its own default of 120 days. It returns 2, noting why on
# stderr, when Homebrew is not installed
oa_brew_clean() {
  if ! test -x "$OA_BREW"; then
    echo 'Skipping the Homebrew cleanup: Homebrew is not installed' >&2
    return 2
  fi
  oa_brew cleanup
}
