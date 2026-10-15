# open-agent's runit service backend: each service environment.json records
# is a root-owned service directory under /etc/sv, enabled by its link in the
# directory runsvdir supervises, and each drops to its own account through
# chpst. Setup and the boot hook source it as root; it needs jq, sv, chpst
# and svlogd on PATH. Every function is safe to rerun, reports why it failed
# on stderr and returns non-zero, and keeps its variables under its own oa_
# prefix since sh has no locals

# where service definitions live, and the directory runsvdir supervises
OA_SV_DEFINITIONS=/etc/sv
OA_SV_SERVICES=/etc/service
# where each service's log goes, one directory a service
OA_SV_LOGS=/var/log/open-agent
# the file that marks a service directory as open-agent's and records its definition
OA_SV_MARK=open-agent.json
# seconds sv waits for a service to start or stop, and setup waits for
# runsvdir to notice a new service, which it looks for every 5 seconds
OA_SV_WAIT=30
# the PATH every service and its run file start with
OA_SV_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# a service name, which names its directory, its link and its log
OA_SV_NAME='^[a-z0-9][a-z0-9._-]*$'
# whether the last oa_sv_write found something to change, and whether it only
# looks: set oa_sv_dry to check what a write would change without writing it
oa_sv_changed=
oa_sv_dry=

# refuses a name that is not a service name
# arguments: the name
oa_sv_name() {
  case $1 in
    '' | [!a-z0-9]* | *[!a-z0-9._-]*)
      echo "Refusing the service name $1" >&2
      return 1
      ;;
  esac
}

# writes a file unless it already holds the contents, root-owned with a mode;
# a dry run only notes that it would
# arguments: path, mode, contents
oa_sv_file() {
  if test -f "$1" && ! test -L "$1" && test "$(cat "$1")" = "$3" &&
    test "$(stat -c '%u %a' "$1")" = "0 ${2#0}"; then
    return 0
  fi
  oa_sv_changed=1
  if test -n "$oa_sv_dry"; then
    return 0
  fi
  printf '%s\n' "$3" >"$1.new" && chmod "$2" "$1.new" && mv -f "$1.new" "$1"
}

# makes a root-owned directory with a mode unless it exists; a dry run only
# notes that it would
# arguments: mode, path
oa_sv_directory() {
  if test -d "$2" && ! test -L "$2"; then
    return 0
  fi
  oa_sv_changed=1
  if test -z "$oa_sv_dry"; then
    install -d -m "$1" "$2"
  fi
}

# tells whether runsv supervises a service
# arguments: service name
oa_sv_supervised() {
  sv status "$OA_SV_DEFINITIONS/$1" >/dev/null 2>&1
}

# tells whether a definition is well formed, before any of it reaches a file
# arguments: the definition, as JSON
oa_sv_valid() {
  printf '%s' "$1" | jq -e --arg name "$OA_SV_NAME" '
    (.name | type == "string" and test($name)) and
    (.account == "root" or .account == "agent") and
    (.command | type == "string" and startswith("/")) and
    (.arguments | type == "array" and all(.[]; type == "string")) and
    (.needs | type == "array" and all(.[]; type == "string" and test($name)))' \
    >/dev/null
}

# renders a definition as its run file: wait for every service it needs, then
# replace the shell with the command, as its account, from its home, with a
# clean environment; every word is quoted, so none is read as shell code
# arguments: the definition, as JSON, and its account's home
oa_sv_run() {
  printf '%s' "$1" | jq -r --arg path "$OA_SV_PATH" --arg wait "$OA_SV_WAIT" \
    --arg services "$OA_SV_SERVICES" --arg home "$2" '
    "#!/bin/sh",
    "# open-agent service \(.name), written from its definition in environment.json",
    "exec 2>&1",
    "PATH=\($path | @sh)",
    "export PATH",
    (.needs[] | "sv -w \($wait) start \("\($services)/\(.)" | @sh) >/dev/null || exit 1"),
    "cd \($home | @sh) || exit 1",
    "exec \(if .account == "root" then "" else "chpst -u \(.account | @sh) " end)env -i HOME=\($home | @sh) USER=\(.account | @sh) LOGNAME=\(.account | @sh) PATH=\"$PATH\" LANG=C.UTF-8 \([.command] + .arguments | map(@sh) | join(" "))"'
}

# writes one service's directory, run file, log and enabling link from its
# definition; what already matches is left as it is, and oa_sv_changed tells
# whether the run file or anything else changed
# arguments: the definition, as JSON
oa_sv_write() {
  oa_sv_changed=
  if ! oa_sv_valid "$1"; then
    echo "Refusing a malformed service definition" >&2
    return 1
  fi
  oa_write_name=$(printf '%s' "$1" | jq -r .name) || return 1
  oa_write_account=$(printf '%s' "$1" | jq -r .account) || return 1
  oa_write_home=$(getent passwd "$oa_write_account" | cut -d: -f6)
  if test -z "$oa_write_home"; then
    echo "There is no account $oa_write_account to run $oa_write_name as" >&2
    return 1
  fi
  oa_write_run=$(oa_sv_run "$1" "$oa_write_home") || return 1
  oa_write_definition=$(printf '%s' "$1" | jq -c .) || return 1
  oa_write_directory=$OA_SV_DEFINITIONS/$oa_write_name
  oa_write_log=$OA_SV_LOGS/$oa_write_name
  oa_sv_directory 0755 "$OA_SV_DEFINITIONS" &&
    oa_sv_directory 0755 "$OA_SV_SERVICES" &&
    oa_sv_directory 0755 "$OA_SV_LOGS" &&
    oa_sv_directory 0755 "$oa_write_directory" &&
    oa_sv_directory 0755 "$oa_write_directory/log" &&
    oa_sv_directory 0700 "$oa_write_log" || return 1
  # the log keeps four rotated files of at most 512 KiB beside the current one
  oa_sv_file "$oa_write_log/config" 0644 "$(printf 's524288\nn4')" &&
    oa_sv_file "$oa_write_directory/log/run" 0755 \
      "$(printf '#!/bin/sh\nexec svlogd -tt %s' "$oa_write_log")" &&
    oa_sv_file "$oa_write_directory/$OA_SV_MARK" 0644 "$oa_write_definition" &&
    oa_sv_file "$oa_write_directory/run" 0755 "$oa_write_run" || return 1
  if test "$(readlink "$OA_SV_SERVICES/$oa_write_name")" = "$oa_write_directory"; then
    return 0
  fi
  oa_sv_changed=1
  if test -z "$oa_sv_dry"; then
    ln -sfn "$oa_write_directory" "$OA_SV_SERVICES/$oa_write_name"
  fi
}

# installs one service from its definition and restarts it when it is
# supervised and anything of it changed; it waits for nothing
# arguments: the definition, as JSON
oa_sv_put() {
  oa_sv_write "$1" || return 1
  oa_put_name=$(printf '%s' "$1" | jq -r .name) || return 1
  if test -n "$oa_sv_changed" && oa_sv_supervised "$oa_put_name"; then
    sv -w "$OA_SV_WAIT" restart "$OA_SV_DEFINITIONS/$oa_put_name" >/dev/null
  fi
}

# waits for runsvdir to supervise a service, then starts it and waits for it
# to run
# arguments: service name
oa_sv_up() {
  oa_up_waited=0
  until oa_sv_supervised "$1"; do
    if test "$oa_up_waited" -ge "$OA_SV_WAIT"; then
      echo "runsvdir does not supervise $1; is it running on $OA_SV_SERVICES?" >&2
      return 1
    fi
    sleep 1
    oa_up_waited=$((oa_up_waited + 1))
  done
  sv -w "$OA_SV_WAIT" start "$OA_SV_DEFINITIONS/$1" >/dev/null
}

# lists the services environment.json records, refusing any name that is not
# a service name
# arguments: path of environment.json
oa_sv_names() {
  if ! jq -e --arg name "$OA_SV_NAME" \
    '.services | type == "array" and all(.[]; .name | type == "string" and test($name))' \
    "$1" >/dev/null; then
    echo "Refusing $1: its services are malformed" >&2
    return 1
  fi
  jq -r '.services[].name' "$1"
}

# prints one service's definition from environment.json
# arguments: path of environment.json, service name
oa_sv_definition() {
  jq -c --arg service "$2" '.services[] | select(.name == $service)' "$1"
}

# lists open-agent's installed services, each marked by its recorded definition
oa_sv_installed() {
  for oa_installed_mark in "$OA_SV_DEFINITIONS"/*/"$OA_SV_MARK"; do
    test -f "$oa_installed_mark" || continue
    oa_installed_name=${oa_installed_mark%/*}
    printf '%s\n' "${oa_installed_name##*/}"
  done
}

# stops and removes one of open-agent's services; a service that is not
# installed is left alone, and one open-agent did not install is refused
# arguments: service name
oa_sv_remove() {
  oa_sv_name "$1" || return 1
  oa_remove_directory=$OA_SV_DEFINITIONS/$1
  if ! test -e "$oa_remove_directory"; then
    rm -f "$OA_SV_SERVICES/$1"
    return 0
  fi
  if ! test -f "$oa_remove_directory/$OA_SV_MARK"; then
    echo "Refusing to remove $1: open-agent did not install it" >&2
    return 1
  fi
  # unlinked first, so runsvdir never starts it again
  rm -f "$OA_SV_SERVICES/$1" || return 1
  if oa_sv_supervised "$1"; then
    sv -w "$OA_SV_WAIT" force-stop "$oa_remove_directory" >/dev/null
    sv exit "$oa_remove_directory" >/dev/null
    oa_remove_waited=0
    while oa_sv_supervised "$1"; do
      if test "$oa_remove_waited" -ge "$OA_SV_WAIT"; then
        echo "runsv of $1 did not exit" >&2
        return 1
      fi
      sleep 1
      oa_remove_waited=$((oa_remove_waited + 1))
    done
  fi
  rm -rf "$oa_remove_directory"
}

# installs every service environment.json records, restarting a supervised
# one whose definition changed, and removes open-agent's services it no
# longer records. It waits for nothing, so the boot hook runs it before it
# starts runsvdir
# arguments: path of environment.json
oa_sv_install() {
  oa_install_names=$(oa_sv_names "$1") || return 1
  for oa_install_name in $oa_install_names; do
    oa_install_definition=$(oa_sv_definition "$1" "$oa_install_name") || return 1
    oa_sv_put "$oa_install_definition" || return 1
  done
  for oa_install_name in $(oa_sv_installed); do
    if ! printf '%s\n' "$oa_install_names" | grep -qxF -- "$oa_install_name"; then
      oa_sv_remove "$oa_install_name" || return 1
    fi
  done
}

# starts every service environment.json records and waits for each to run
# arguments: path of environment.json
oa_sv_start() {
  oa_start_names=$(oa_sv_names "$1") || return 1
  for oa_start_name in $oa_start_names; do
    oa_sv_up "$oa_start_name" || return 1
  done
}

# tells whether every service environment.json records is installed as it is
# defined and running, and no other of open-agent's services is installed
# arguments: path of environment.json
oa_sv_check() {
  oa_check_names=$(oa_sv_names "$1") || return 1
  for oa_check_name in $oa_check_names; do
    oa_check_definition=$(oa_sv_definition "$1" "$oa_check_name") || return 1
    oa_sv_dry=1
    oa_sv_write "$oa_check_definition"
    oa_check_status=$?
    oa_sv_dry=
    if test "$oa_check_status" -ne 0 || test -n "$oa_sv_changed"; then
      return 1
    fi
    sv status "$OA_SV_DEFINITIONS/$oa_check_name" 2>/dev/null | grep -q '^run:' ||
      return 1
  done
  test "$(oa_sv_installed | sort)" = "$(printf '%s\n' "$oa_check_names" | sort)"
}

# installs one service from its definition and waits for it to run
# arguments: the definition, as JSON
oa_sv_ensure() {
  oa_sv_put "$1" || return 1
  oa_sv_up "$(printf '%s' "$1" | jq -r .name)"
}

# stops one of open-agent's services and waits for it to stop; exits 2 when
# it is not installed, and 1 when it did not stop in time
# arguments: service name
oa_sv_stop() {
  oa_sv_name "$1" || return 2
  if ! test -f "$OA_SV_DEFINITIONS/$1/$OA_SV_MARK"; then
    echo "There is no open-agent service $1" >&2
    return 2
  fi
  if ! oa_sv_supervised "$1"; then
    return 0
  fi
  sv -w "$OA_SV_WAIT" stop "$OA_SV_DEFINITIONS/$1" >/dev/null
}

# prints the state of each of open-agent's services as one JSON line of
# {name, status, needs, startedAt}; a service runsv does not supervise is
# stopped
oa_sv_states() {
  oa_states_now=$(date +%s) || return 1
  for oa_states_name in $(oa_sv_installed); do
    oa_states_line=$(sv status "$OA_SV_DEFINITIONS/$oa_states_name" 2>/dev/null) ||
      oa_states_line=
    oa_states_started=
    case $oa_states_line in
      run:*)
        oa_states_status=running
        # `run: /etc/sv/name: (pid 123) 45s; run: log: ...`
        oa_states_seconds=$(printf '%s' "$oa_states_line" |
          sed -n 's/^run:[^)]*) \([0-9][0-9]*\)s.*/\1/p')
        if test -n "$oa_states_seconds"; then
          oa_states_started=$(date -u -d "@$((oa_states_now - oa_states_seconds))" \
            +%Y-%m-%dT%H:%M:%SZ) || return 1
        fi
        ;;
      down:*'want up'*) oa_states_status=starting ;;
      finish:*) oa_states_status=stopping ;;
      *) oa_states_status=stopped ;;
    esac
    jq -c --arg status "$oa_states_status" --arg started "$oa_states_started" \
      '{name, status: $status, needs} + (if $started == "" then {} else {startedAt: $started} end)' \
      "$OA_SV_DEFINITIONS/$oa_states_name/$OA_SV_MARK" || return 1
  done
}

# prints the state of every one of open-agent's services as one JSON array
oa_sv_list() {
  oa_list_states=$(oa_sv_states) || return 1
  printf '%s\n' "$oa_list_states" | jq -s -c .
}
