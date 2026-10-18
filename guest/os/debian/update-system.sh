# the system-package part of the debian family's updater, sourced after the
# family library: it refreshes apt's lists and upgrades the packages of every
# system tool environment.json records, never installing a missing one.
# environment.json lists its tools under `tools`, each with the source setup
# resolved for it; a system source names its packages under `packages`. No
# package it upgrades starts, stops or restarts a daemon: open-agent's
# policy-rc.d refuses every one while OA_POLICY_HOLD is set, and needrestart
# stays suspended. Its cleanup removes the package files of superseded
# versions from apt's download cache once the upgrade is recorded

# upgrades the system tools environment.json records
# arguments: path of environment.json
oa_update_system() {
  if ! test -x /usr/bin/jq; then
    echo "The updater needs the system's jq to read $1" >&2
    return 1
  fi
  oa_update_packages=$(/usr/bin/jq -r \
    '[.tools[]? | .source | select(.kind == "system") | .packages[]] | unique | .[]' \
    "$1") || return 1
  set --
  while IFS= read -r oa_update_package; do
    test -z "$oa_update_package" || set -- "$@" "$oa_update_package"
  done <<EOF
$oa_update_packages
EOF
  test "$#" -gt 0 || return 0
  oa_policy_rc_install || return 1
  (
    OA_POLICY_HOLD=1
    NEEDRESTART_SUSPEND=1
    export OA_POLICY_HOLD NEEDRESTART_SUSPEND
    oa_lists_update && oa_pkg_upgrade "$@"
  )
}

# minutes a downloaded package must have rested in apt's cache before a
# cleanup may remove it, so a download another apt run has made and not yet
# installed is never taken from under it
OA_CLEAN_SETTLE_MINUTES=10

# prints the directory apt keeps its downloaded packages in
oa_update_archives() {
  oa_archives_line=$(apt-config shell oa_archives_dir Dir::Cache::archives/) || return 1
  oa_archives_dir=${oa_archives_line#*=\'}
  oa_archives_dir=${oa_archives_dir%\'}
  case $oa_archives_dir in
    /*) echo "${oa_archives_dir%/}" ;;
    *) return 1 ;;
  esac
}

# prints the directories a cleanup of the system packages shrinks
oa_update_system_clean_roots() {
  oa_update_archives 2>/dev/null
}

# cleans up after the system packages' update: it removes from apt's download
# cache the package files of versions an upgrade replaced, and the leftovers of
# an interrupted download. A file stays when its package is not installed, and
# so does the file of every installed version, since the boot hook reinstalls
# the recorded packages from this cache alone, on a root filesystem rebuilt;
# `apt-get autoclean` removes both, so it never runs. It returns 2, with the
# note on stderr, when apt keeps no cache
oa_update_system_clean() {
  if ! oa_clean_archives=$(oa_update_archives) || ! test -d "$oa_clean_archives" ||
    test -L "$oa_clean_archives"; then
    echo 'Skipping the system cleanup: apt keeps no package cache' >&2
    return 2
  fi
  oa_clean_work=$(mktemp -d) || return 1
  oa_clean_stale_status=0
  # each installed package's status, name, version and architecture
  dpkg-query -W -f="\${db:Status-Abbrev}\t\${Package}\t\${Version}\t\${Architecture}\n" \
    >"$oa_clean_work/installed" &&
    find "$oa_clean_archives" -maxdepth 1 -type f -name '*.deb' \
      -cmin "+$OA_CLEAN_SETTLE_MINUTES" -printf '%f\n' >"$oa_clean_work/files" &&
    awk -F '\t' '
      FNR == NR {
        if (substr($1, 2, 1) !~ /[nc]/ && $3 != "") {
          version = $3
          gsub(/:/, "%3a", version)
          known[$2] = 1
          keep[$2 "_" version "_" $4 ".deb"] = 1
        }
        next
      }
      /^[a-z0-9][A-Za-z0-9.+_%~-]*\.deb$/ {
        name = $0
        sub(/_.*/, "", name)
        if ((name in known) && !($0 in keep)) print
      }' "$oa_clean_work/installed" "$oa_clean_work/files" >"$oa_clean_work/stale" || oa_clean_stale_status=1
  if test "$oa_clean_stale_status" = 0; then
    while IFS= read -r oa_clean_stale; do
      echo "Removing the superseded package file $oa_clean_stale"
      rm -f -- "$oa_clean_archives/$oa_clean_stale" || oa_clean_stale_status=1
    done <"$oa_clean_work/stale"
    # downloads an interrupted run left half done
    if test -d "$oa_clean_archives/partial"; then
      find "$oa_clean_archives/partial" -type f -cmin "+$OA_CLEAN_SETTLE_MINUTES" -delete ||
        oa_clean_stale_status=1
    fi
  fi
  rm -rf "$oa_clean_work"
  if test "$oa_clean_stale_status" != 0; then
    echo "apt's package cache could not be cleaned" >&2
  fi
  return "$oa_clean_stale_status"
}
