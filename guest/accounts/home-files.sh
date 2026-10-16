#!/bin/sh
# changes one file or directory in an account's home as that account, never
# as root: setup runs it with `sh -c` behind runuser, so root never follows a
# link the account controls. It refuses a symbolic link, a component another
# account owns or another account may write, at and below the home. `write`
# replaces the file with standard input atomically, private to the account;
# `mkdir` creates the missing directories, private to the account; `remove`
# deletes a regular file the account owns, or nothing when it is absent
# arguments: mkdir|write|remove, the home, then the path inside it

umask 077
oa_operation=$1
oa_home=$2
oa_path=$3
oa_uid=$(id -u)

# reports why the change was refused and exits non-zero
# arguments: the reason
oa_refuse() {
  echo "home files: $1" >&2
  exit 1
}

# tells whether the account owns a path that passes further find tests
# arguments: the path, then the find tests
oa_owned() {
  oa_target=$1
  shift
  test -n "$(find "$oa_target" -maxdepth 0 -user "$oa_uid" "$@")"
}

# tells whether a path is a directory the account owns and alone may write
# arguments: the path
oa_trusted_directory() {
  test ! -L "$1" && test -d "$1" && oa_owned "$1" -type d ! -perm -020 ! -perm -002
}

# checks every directory from the home down to a path, creating the missing
# ones when asked; it runs in a subshell, so its word splitting stays its own
# arguments: the directory, then `create` to create the missing ones
oa_walk() (
  oa_current=$oa_home
  oa_trusted_directory "$oa_current" || oa_refuse "$oa_current is not the account's private home"
  IFS=/
  set -f
  for oa_part in ${1#"$oa_home"}; do
    test -n "$oa_part" || continue
    oa_current=$oa_current/$oa_part
    if test "$2" = create && test ! -e "$oa_current" && test ! -L "$oa_current"; then
      mkdir -m 0700 "$oa_current" || oa_refuse "$oa_current could not be created"
    fi
    oa_trusted_directory "$oa_current" || oa_refuse "$oa_current is a link or not the account's own directory"
  done
)

# tells whether a path is absent or a regular file the account owns
# arguments: the path
oa_replaceable() {
  test ! -L "$1" && { test ! -e "$1" || oa_owned "$1" -type f; }
}

test "$oa_uid" != 0 || oa_refuse 'refusing to run as root'
case $oa_path in
  "$oa_home"/*) ;;
  *) oa_refuse "$oa_path is outside $oa_home" ;;
esac
case $oa_path/ in
  */../* | */./* | *//*) oa_refuse "$oa_path is not a normalized path" ;;
esac

oa_parent=${oa_path%/*}
case $oa_operation in
  mkdir)
    oa_walk "$oa_path" create || exit 1
    chmod 0700 "$oa_path"
    ;;
  write)
    oa_walk "$oa_parent" || exit 1
    oa_replaceable "$oa_path" || oa_refuse "$oa_path is a link or not the account's own file"
    oa_temporary=$(mktemp "$oa_parent/.open-agent-XXXXXXXXXX") || exit 1
    trap 'rm -f "$oa_temporary"' EXIT
    cat >"$oa_temporary" || exit 1
    oa_walk "$oa_parent" || exit 1
    oa_replaceable "$oa_path" || oa_refuse "$oa_path is a link or not the account's own file"
    mv -f "$oa_temporary" "$oa_path"
    ;;
  remove)
    oa_walk "$oa_parent" || exit 1
    oa_replaceable "$oa_path" || oa_refuse "$oa_path is a link or not the account's own file"
    rm -f "$oa_path"
    ;;
  *)
    oa_refuse "unknown operation $oa_operation"
    ;;
esac
