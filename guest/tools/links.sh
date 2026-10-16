# open-agent's tool links, sourced as root: every executable environment.json
# lists for a Homebrew tool gets a link in the tool links directory to its keg's opt
# link, unless the system provides a command of that name, which the agent
# finds in Homebrew's own directories on its PATH instead. A link is only
# made where none is, or replaced where it points elsewhere into the prefix;
# anything else there, and every system or agent tool, is left alone. Root
# reads environment.json with the system's jq alone

# the links go in $OA_TOOL_LINKS and point into $OA_HOMEBREW_PREFIX, and no
# link shadows a command in $OA_SYSTEM_DIRECTORIES, the system's command
# directories separated by blanks, all from the header
OA_LINK_JQ=/usr/bin/jq

# refuses a formula, keg directory or executable a link could escape with
# arguments: formula, keg directories separated by blanks, executables separated by blanks
oa_link_names() {
  case $1 in
    '' | [!a-z0-9]* | *[!a-z0-9@._+-]*)
      echo "Refusing the formula $1" >&2
      return 1
      ;;
  esac
  for oa_names_directory in $2; do
    case $oa_names_directory in
      '' | /* | */ | *//* | *[!a-z/]*)
        echo "Refusing the keg directory $oa_names_directory" >&2
        return 1
        ;;
    esac
  done
  for oa_names_executable in $3; do
    case $oa_names_executable in
      '' | [!A-Za-z0-9]* | *[!A-Za-z0-9._+-]*)
        echo "Refusing the executable $oa_names_executable" >&2
        return 1
        ;;
    esac
  done
}

# tells whether the system provides a command
# arguments: the command's name
oa_link_system() {
  for oa_system_directory in $OA_SYSTEM_DIRECTORIES; do
    test -e "$oa_system_directory/$1" && return 0
  done
  return 1
}

# links, or with `check` only tells whether it would link, a Homebrew tool's
# executables; every executable must be in one of the keg directories. One the
# system provides is not linked, and its link into the prefix is removed
# arguments: `apply` or `check`, formula, keg directories separated by
# blanks, executables separated by blanks
oa_link_tool() {
  oa_link_mode=$1
  shift
  oa_link_names "$@" || return 1
  for oa_link_executable in $3; do
    oa_link_target=
    for oa_link_directory in $2; do
      oa_link_candidate=$OA_HOMEBREW_PREFIX/opt/$1/$oa_link_directory/$oa_link_executable
      if test -f "$oa_link_candidate" && test -x "$oa_link_candidate"; then
        oa_link_target=$oa_link_candidate
        break
      fi
    done
    if test -z "$oa_link_target"; then
      echo "$1 has no executable $oa_link_executable in $2" >&2
      return 1
    fi
    oa_link_path=$OA_TOOL_LINKS/$oa_link_executable
    if oa_link_system "$oa_link_executable"; then
      test -L "$oa_link_path" || continue
      case $(readlink "$oa_link_path") in
        "$OA_HOMEBREW_PREFIX"/*) ;;
        *) continue ;;
      esac
      test "$oa_link_mode" = apply || return 1
      rm -f "$oa_link_path" || return 1
      continue
    fi
    if test -L "$oa_link_path"; then
      oa_link_current=$(readlink "$oa_link_path")
      test "$oa_link_current" != "$oa_link_target" || continue
      case $oa_link_current in
        "$OA_HOMEBREW_PREFIX"/*) ;;
        *)
          echo "Leaving $oa_link_path: it points outside Homebrew, to $oa_link_current" >&2
          continue
          ;;
      esac
    elif test -e "$oa_link_path"; then
      echo "Leaving $oa_link_path: it is not a link" >&2
      continue
    fi
    test "$oa_link_mode" = apply || return 1
    install -d -m 0755 "$OA_TOOL_LINKS" || return 1
    ln -sfn "$oa_link_target" "$oa_link_path.open-agent-new" &&
      mv -fT "$oa_link_path.open-agent-new" "$oa_link_path" || return 1
  done
  return 0
}

# restores the links of every Homebrew tool environment.json records, such as
# on a rebuilt root filesystem
# arguments: path of environment.json
oa_links_restore() {
  if ! test -x "$OA_LINK_JQ"; then
    echo "Restoring links needs $OA_LINK_JQ to read $1" >&2
    return 1
  fi
  oa_restore_tools=$("$OA_LINK_JQ" -r '.tools[]?
    | select(.source.kind == "brew")
    | [.source.formula, ((.source.binDirs // ["bin"]) | join(" ")), (.executables | join(" "))]
    | @tsv' "$1") || return 1
  oa_restore_status=0
  while IFS="$(printf '\t')" read -r oa_restore_formula oa_restore_directories oa_restore_executables; do
    test -n "$oa_restore_formula" || continue
    oa_link_tool apply "$oa_restore_formula" "$oa_restore_directories" "$oa_restore_executables" ||
      oa_restore_status=1
  done <<EOF
$oa_restore_tools
EOF
  return "$oa_restore_status"
}
