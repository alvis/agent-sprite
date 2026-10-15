# open-agent's periodic jobs: each job environment.json records is one line of
# a root-owned file in /etc/cron.d, which the cron service, under whichever
# backend runs the services, runs as the job's account. Setup and the boot
# hook source it as root; it needs jq on PATH. Every function is safe to
# rerun, reports why it failed on stderr and returns non-zero

# the jobs' file; cron ignores a name with a dot, such as its temporary copy
OA_CRON_FILE=/etc/cron.d/open-agent
# the PATH every job starts with
OA_CRON_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# prints the crontab of the jobs environment.json records, or nothing when it
# records none; a job runs every whole number of minutes that divides an
# hour, or every whole number of hours that divides a day. Every word of a
# command is quoted and its `%` escaped, so cron reads none of it
# arguments: path of environment.json
oa_cron_render() {
  jq -r --arg path "$OA_CRON_PATH" '
    def schedule:
      if . >= 1 and . < 60 and 60 % . == 0 then
        if . == 1 then "* * * * *" else "*/\(.) * * * *" end
      elif . >= 60 and . % 60 == 0 and 1440 % . == 0 then
        (. / 60 | if . == 1 then "0 * * * *" elif . == 24 then "0 0 * * *" else "0 */\(.) * * *" end)
      else error("a job cannot run every \(.) minutes") end;
    def account:
      if . == "root" or . == "agent" then . else error("a job cannot run as \(.)") end;
    if (.jobs | length) == 0 then empty else
      "# open-agent periodic jobs, written from environment.json",
      "SHELL=/bin/sh",
      "PATH=\($path)",
      (.jobs[] |
        "# \(.name)",
        "\(.everyMinutes | schedule) \(.run.account | account) \([.run.command] + .run.arguments | map(@sh) | join(" ") | gsub("%"; "\\%")) >/dev/null 2>&1")
    end' "$1"
}

# writes the jobs environment.json records, root-owned with mode 0644 as cron
# requires, or removes the file when it records none; a file already
# holding them is left as it is
# arguments: path of environment.json
oa_cron_install() {
  oa_cron_contents=$(oa_cron_render "$1") || return 1
  if test -z "$oa_cron_contents"; then
    rm -f "$OA_CRON_FILE"
    return
  fi
  if oa_cron_check "$1"; then
    return 0
  fi
  install -d -m 0755 "${OA_CRON_FILE%/*}" || return 1
  printf '%s\n' "$oa_cron_contents" >"$OA_CRON_FILE.new" &&
    chmod 0644 "$OA_CRON_FILE.new" && mv -f "$OA_CRON_FILE.new" "$OA_CRON_FILE"
}

# tells whether the jobs' file holds exactly the jobs environment.json
# records, root-owned with mode 0644, or is absent when it records none
# arguments: path of environment.json
oa_cron_check() {
  oa_cron_expected=$(oa_cron_render "$1") || return 1
  if test -z "$oa_cron_expected"; then
    ! test -e "$OA_CRON_FILE"
    return
  fi
  test -f "$OA_CRON_FILE" && ! test -L "$OA_CRON_FILE" &&
    test "$(stat -c '%u %a' "$OA_CRON_FILE")" = '0 644' &&
    test "$(cat "$OA_CRON_FILE")" = "$oa_cron_expected"
}
