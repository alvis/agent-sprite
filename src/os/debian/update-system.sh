# the system-package part of the debian family's updater, sourced after the
# family library: it refreshes apt's lists and upgrades the packages of every
# system tool environment.json records, never installing a missing one.
# environment.json lists its tools under `tools`, each with the source setup
# resolved for it; a system source names its packages under `packages`

# upgrades the system tools environment.json records
# arguments: path of environment.json
oa_update_system() {
  oa_update_jq=$(command -v jq 2>/dev/null || printf '%s' /home/linuxbrew/.linuxbrew/bin/jq)
  if ! test -x "$oa_update_jq"; then
    echo "The updater needs jq to read $1" >&2
    return 1
  fi
  oa_update_packages=$("$oa_update_jq" -r \
    '[.tools[]? | .source | select(.kind == "system") | .packages[]] | unique | .[]' \
    "$1") || return 1
  set --
  while IFS= read -r oa_update_package; do
    test -z "$oa_update_package" || set -- "$@" "$oa_update_package"
  done <<EOF
$oa_update_packages
EOF
  test "$#" -gt 0 || return 0
  oa_lists_update || return 1
  oa_pkg_upgrade "$@"
}
