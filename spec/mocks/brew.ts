import { execFile } from 'node:child_process';
import {
  chmod,
  mkdtempDisposable,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

/** what the stand-in Homebrew has installed and does when asked */
export interface BrewScenario {
  /** each installed formula by its short name, with its version */
  installed: Readonly<Record<string, string>>;
  /** names brew resolves to another formula, such as `python3` to `python@3.13` */
  aliases?: Readonly<Record<string, string>>;
  /** the formulae `brew outdated` names, one a line, as it prints them */
  outdated?: readonly string[];
  /** the version an upgrade moves each formula to */
  newer?: Readonly<Record<string, string>>;
  /** formulae whose upgrade fails, leaving them at their version */
  broken?: readonly string[];
  /** formulae whose upgrade fails beside others, yet succeeds alone */
  crowded?: readonly string[];
  /** formulae moved to their new version before their post-install step fails */
  postinstallFails?: readonly string[];
  /** formulae whose first version read after a failed upgrade fails */
  unreadableAfterUpgrade?: readonly string[];
  /** formulae whose new version has no bottle for the guest */
  unbottled?: readonly string[];
  /** true when the listing of every installed formula fails */
  shouldFailListing?: boolean;
  /** true when brew cannot refresh its formula data */
  shouldFailRefresh?: boolean;
}

/** the scenario and guest script run with the stand-in Homebrew */
export interface BrewRunParams {
  /** what the stand-in Homebrew has and does */
  scenario: BrewScenario;
  /** guest paths of libraries sourced after Homebrew's */
  libraries: readonly string[];
  /** the script that runs last */
  script: string;
  /** files written to the work directory first */
  files?: Readonly<Record<string, string>>;
}

/** a guest shell that ran with the stand-in Homebrew */
export interface BrewRun {
  /** the shell's exit status */
  exitCode: number;
  /** the shell's standard output */
  stdout: string;
  /** every brew run, its arguments joined by spaces, in order */
  calls: string[];
  /** environment.json in the work directory once the shell ended, empty when absent */
  environment: string;
  /** update-status.json in the work directory once the shell ended, empty when absent */
  status: string;
}

/** the guest program directory the libraries are read from */
const GUEST_ROOT = resolve(import.meta.dirname, '../../guest');

/** a brew that answers from the scenario's files in its state directory */
const FAKE_BREW = `#!/bin/sh
state=$(dirname "$0")
printf '%s\\n' "$*" >>"$state/calls"
command=$1
shift
case $command in
  list)
    shift 2
    if test "$#" -eq 0; then
      test ! -e "$state/listing-fails" || exit 1
      if test -e "$state/failed-upgrade" && test -s "$state/unreadable-after-upgrade"; then
        exit 1
      fi
      cat "$state/installed"
      exit 0
    fi
    if test -e "$state/failed-upgrade" && grep -qxF "$1" "$state/unreadable-after-upgrade"; then
      awk -v name="$1" '$0 != name' "$state/unreadable-after-upgrade" >"$state/unreadable.new" &&
        mv "$state/unreadable.new" "$state/unreadable-after-upgrade"
      exit 1
    fi
    name=$(awk -v name="$1" '$1 == name { print $2; exit }' "$state/aliases")
    name=\${name:-$1}
    awk -v name="\${name##*/}" '$1 == name { print; found = 1 } END { exit !found }' "$state/installed"
    ;;
  outdated)
    test ! -e "$state/refresh-fails" || exit 1
    cat "$state/outdated"
    ;;
  upgrade)
    shift
    status=0
    for formula; do
      if grep -qxF "$formula" "$state/broken" ||
        { test "$#" -gt 1 && grep -qxF "$formula" "$state/crowded"; }; then
        status=1
        continue
      fi
      awk -v name="\${formula##*/}" 'NR == FNR { if ($1 == name) newer = $2; next }
        $1 == name && newer != "" { $2 = newer } { print }' \\
        "$state/newer" "$state/installed" >"$state/installed.new" &&
        mv "$state/installed.new" "$state/installed"
      if test ! -e "$state/failed-upgrade" && grep -qxF "$formula" "$state/postinstall-fails"; then
        status=1
      fi
    done
    test "$status" -eq 0 || touch "$state/failed-upgrade"
    exit "$status"
    ;;
  cleanup) ;;
  *) exit 64 ;;
esac
`;

const execFileAsync = promisify(execFile);

/**
 * runs a script in sh after the Homebrew library and further guest libraries,
 * as the guest sources them, with brew standing in for Homebrew: it answers
 * from the scenario and logs every run. The shell's work directory is
 * `$OA_TEST_WORK`; `oa_as` runs commands directly and the bottle probe reads
 * the scenario's unbottled formulae
 * @param params the scenario, the guest libraries after Homebrew's and the script
 * @param params.scenario what the stand-in Homebrew has and does
 * @param params.libraries guest paths of libraries sourced after Homebrew's
 * @param params.script the script that runs last
 * @param params.files files written to the work directory first
 * @returns the shell's status, output, brew's runs and the records it left
 */
export async function runWithBrew(params: BrewRunParams): Promise<BrewRun> {
  const { scenario, libraries, script, files = {} } = params;
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-brew-'),
  );
  const state = join(directory.path, 'brew');
  const work = join(directory.path, 'work');
  await execFileAsync('mkdir', ['-p', join(state, 'bin'), work]);
  const lines = (entries: Readonly<Record<string, string>> = {}): string =>
    Object.entries(entries)
      .map(([name, value]) => `${name} ${value}\n`)
      .join('');
  const list = (names: readonly string[] = []): string =>
    names.map((name) => `${name}\n`).join('');
  await Promise.all([
    writeFile(join(state, 'bin/brew'), FAKE_BREW),
    writeFile(join(state, 'bin/installed'), lines(scenario.installed)),
    writeFile(join(state, 'bin/aliases'), lines(scenario.aliases)),
    writeFile(join(state, 'bin/outdated'), list(scenario.outdated)),
    writeFile(join(state, 'bin/newer'), lines(scenario.newer)),
    writeFile(join(state, 'bin/broken'), list(scenario.broken)),
    writeFile(join(state, 'bin/crowded'), list(scenario.crowded)),
    writeFile(
      join(state, 'bin/postinstall-fails'),
      list(scenario.postinstallFails),
    ),
    writeFile(
      join(state, 'bin/unreadable-after-upgrade'),
      list(scenario.unreadableAfterUpgrade),
    ),
    writeFile(join(state, 'bin/unbottled'), list(scenario.unbottled)),
    writeFile(join(state, 'bin/calls'), ''),
    ...(scenario.shouldFailListing
      ? [writeFile(join(state, 'bin/listing-fails'), '')]
      : []),
    ...(scenario.shouldFailRefresh
      ? [writeFile(join(state, 'bin/refresh-fails'), '')]
      : []),
    ...Object.entries(files).map(async ([name, content]) =>
      writeFile(join(work, name), content),
    ),
  ]);
  await chmod(join(state, 'bin/brew'), 0o755);
  const sources = ['tools/homebrew/lib.sh', ...libraries]
    .map((library) => `. '${join(GUEST_ROOT, library)}'`)
    .join('\n');
  const program = `set -u
oa_as() { shift; "$@"; }
${sources}
oa_brew_unbottled() {
  for oa_test_formula; do
    ! grep -qxF "$oa_test_formula" '${state}/bin/unbottled' || echo "no-bottle:$oa_test_formula"
  done
}
${script}`;
  const { exitCode, stdout } = await execFileAsync('sh', ['-c', program], {
    env: {
      PATH: process.env.PATH,
      OA_LINUXBREW_HOME: state,
      OA_HOMEBREW_PREFIX: state,
      OA_HOMEBREW_PATH: join(state, 'bin'),
      OA_SYSTEM_PATH: '/usr/bin:/bin',
      OA_TEST_WORK: work,
    },
  }).then(
    ({ stdout: output }) => ({ exitCode: 0, stdout: output }),
    (error: { code: number; stdout: string }) => ({
      exitCode: error.code,
      stdout: error.stdout,
    }),
  );
  const calls = (await readFile(join(state, 'bin/calls'), 'utf8'))
    .split('\n')
    .filter((line) => line !== '');
  const left = async (name: string): Promise<string> =>
    readFile(join(work, name), 'utf8').catch(() => '');

  return {
    exitCode,
    stdout,
    calls,
    environment: await left('environment.json'),
    status: await left('update-status.json'),
  };
}
