# open-agent's tool version record, sourced as root after the OS family's
# library and the Homebrew, npm and rustup libraries, whose version helpers it
# asks: setup, once every tool step ran, and the updater, once its upgrades
# ran, record in environment.json the version each tool's manager reports
# installed, so the record follows what the guest has rather than what was
# asked for. A system tool, and a tool whose version cannot be read, is
# recorded without one. Root reads and rewrites environment.json with the
# system's jq alone

OA_VERSIONS_JQ=/usr/bin/jq

# prints the version a tool's manager reports installed
# arguments: the source's kind, then its formula, package or toolchain, then
# the file of the Homebrew listing oa_brew_listing printed for this record
oa_tools_version() {
  case $1 in
    brew) oa_brew_listed_version "$3" "$2" ;;
    npm) oa_npm_version "$2" ;;
    rustup) oa_rustup_version "$2" | cut -d ' ' -f 2 ;;
    *) return 1 ;;
  esac
}

# records in environment.json the version each tool's manager reports
# installed, dropping any version recorded before for a tool whose version
# cannot be read now; the record is replaced at once, root's and readable by
# every account, so a reader never sees half of it. Homebrew's formulae are
# read from one listing taken afresh for this record, a formula it cannot name
# asking brew alone, as does every formula when the listing fails
# arguments: path of environment.json
oa_tools_record_versions() {
  if ! test -x "$OA_VERSIONS_JQ"; then
    echo "Recording the tool versions needs $OA_VERSIONS_JQ to read $1" >&2
    return 1
  fi
  oa_versions_tools=$("$OA_VERSIONS_JQ" -r '.tools[]?
    | select(.source.kind != "system")
    | [.name, .source.kind, (.source.formula // .source.package // .source.toolchain // "")]
    | @tsv' "$1") || return 1
  oa_versions_listed=$(mktemp) || return 1
  if printf '%s\n' "$oa_versions_tools" | cut -f 2 | grep -qx brew; then
    oa_brew_listing >"$oa_versions_listed" 2>/dev/null || : >"$oa_versions_listed"
  fi
  oa_versions_found=
  while IFS="$(printf '\t')" read -r oa_versions_name oa_versions_kind oa_versions_subject <&3; do
    test -n "$oa_versions_name" || continue
    oa_versions_version=$(oa_tools_version "$oa_versions_kind" "$oa_versions_subject" "$oa_versions_listed" 2>/dev/null |
      head -n 1 | tr -d '\r\t') || oa_versions_version=
    test -n "$oa_versions_version" || continue
    oa_versions_found=$oa_versions_found$(printf '\n%s\t%s' "$oa_versions_name" "$oa_versions_version")
  done 3<<EOF
$oa_versions_tools
EOF
  rm -f "$oa_versions_listed"
  oa_versions_file=$(mktemp "${1%/*}/.environment.XXXXXX") || return 1
  if "$OA_VERSIONS_JQ" --arg found "$oa_versions_found" '
      ($found | split("\n") | map(select(. != "") | split("\t") | {(.[0]): .[1]}) | add // {}) as $versions
      | .tools |= map(if $versions[.name] then .version = $versions[.name] else del(.version) end)' \
    "$1" >"$oa_versions_file" &&
    chmod 0644 "$oa_versions_file" &&
    mv -f "$oa_versions_file" "$1"; then
    return 0
  fi
  rm -f "$oa_versions_file"
  echo "Could not record the tool versions in $1" >&2
  return 1
}
