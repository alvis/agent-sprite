import { LINUXBREW_HOME } from '#integrations/guest/layout';
import {
  HOMEBREW_INSTALLER,
  HOMEBREW_LIBRARY,
  HOMEBREW_RELEASE,
  NO_BOTTLE_PREFIX,
} from '#tools/libraries';

import { libraryCommand } from './library';

import type { OsFamily } from '#os/contracts';
import type { Resolution } from '#tools/contracts';
import type { RefusedSource } from '#tools/resolve';

import type { SetupStep, StepCommand } from '../contracts';

import type { LibraryCall } from './library';

/** id of the step that installs Homebrew */
export const HOMEBREW_STEP = 'homebrew';

/**
 * the Homebrew account's ids where the provider keeps none of its own: system
 * ids midway through the range packages allocate theirs from, from 999 down
 * as systemd-sysusers and `useradd --system` do and from 100 up as `adduser
 * --system` does, so the bootstrap packages leave them free
 */
const HOMEBREW_ACCOUNT_IDS = { uid: 900, gid: 900 } as const;

/** longest one command of the Homebrew step may take: the installer clones Homebrew */
const HOMEBREW_LIMIT_MS = 1_200_000;
/** longest the bottle probe may take: it reads every formula's dependencies */
const BOTTLE_PROBE_LIMIT_MS = 600_000;

/** what the Homebrew step is built with */
interface HomebrewStepParams {
  /** the guest's OS family, whose shell and library the step uses */
  family: Pick<OsFamily, 'shell' | 'library'>;
  /** system packages Homebrew needs first, as the family reported them */
  prerequisites: readonly string[];
  /** ids of steps the Homebrew step needs */
  needs?: readonly string[];
  /** the account's ids; the system ids {@link HOMEBREW_ACCOUNT_IDS} when absent */
  ids?: { uid: number; gid: number };
  /** whether a failure stops setup, as it should when a required tool is a formula */
  critical: boolean;
}

/**
 * builds the step that installs Homebrew: it creates the linuxbrew system
 * account, with no login, a locked password and no sudo rule, installs the
 * prerequisites, runs the pinned official installer as that account, then
 * checks out the pinned Homebrew release
 * @param params the family, prerequisites, needs, ids and criticality
 * @returns a root step whose check and verify ask whether Homebrew is
 * installed and runs the pinned release
 */
export function homebrewStep(params: HomebrewStepParams): SetupStep {
  const {
    family,
    prerequisites,
    needs = [],
    ids = HOMEBREW_ACCOUNT_IDS,
    critical,
  } = params;
  const command = (calls: readonly LibraryCall[]): StepCommand =>
    libraryCommand(family.shell, [family.library, HOMEBREW_LIBRARY], calls);
  const pinned: LibraryCall[] = [
    ['oa_homebrew_installed'],
    ['oa_homebrew_pinned', HOMEBREW_RELEASE.commit],
  ];

  return {
    id: HOMEBREW_STEP,
    component: 'homebrew',
    account: 'root',
    needs,
    check: command(pinned),
    apply: command([
      [
        'oa_account_ensure',
        'linuxbrew',
        String(ids.uid),
        String(ids.gid),
        LINUXBREW_HOME,
        '/usr/sbin/nologin',
        'system',
      ],
      ...(prerequisites.length > 0
        ? [['oa_pkg_install', ...prerequisites] as const]
        : []),
      [
        'oa_homebrew_install',
        HOMEBREW_INSTALLER.url,
        HOMEBREW_INSTALLER.sha256,
      ],
      ['oa_homebrew_pin', HOMEBREW_RELEASE.tag, HOMEBREW_RELEASE.commit],
    ]),
    verify: command(pinned),
    timeoutMs: HOMEBREW_LIMIT_MS,
    critical,
    retry: 'transport',
  };
}

/**
 * renders the command that asks the installed Homebrew which formulae have
 * no bottle, for themselves or a dependency, for the guest's architecture;
 * it prints one `no-bottle:<formula>` line for each
 * @param family the guest's OS family
 * @param resolutions the resolutions whose formulae are probed
 * @returns the command, or nothing when no tool resolved to a formula
 */
export function bottleProbe(
  family: Pick<OsFamily, 'shell' | 'library'>,
  resolutions: readonly Resolution[],
): StepCommand | undefined {
  const formulae = [...new Set(resolutions.flatMap(formulaOf))];
  if (formulae.length === 0) {
    return undefined;
  }

  return {
    ...libraryCommand(
      family.shell,
      [family.library, HOMEBREW_LIBRARY],
      [['oa_brew_unbottled', ...formulae]],
    ),
    timeoutMs: BOTTLE_PROBE_LIMIT_MS,
  };
}

/**
 * turns the bottle probe's report into the sources the guest turns down, so
 * resolving again falls through to each tool's next source
 * @param report the probe's standard output
 * @param resolutions the resolutions the probe was for
 * @returns a refusal per tool whose formula has no bottle
 */
export function refusedBottles(
  report: string,
  resolutions: readonly Resolution[],
): RefusedSource[] {
  const unbottled = new Set(
    report
      .split('\n')
      .filter((line) => line.startsWith(NO_BOTTLE_PREFIX))
      .map((line) => line.slice(NO_BOTTLE_PREFIX.length).trim()),
  );

  return resolutions.flatMap((resolution) =>
    'source' in resolution &&
    resolution.source.kind === 'brew' &&
    unbottled.has(resolution.source.formula)
      ? [
          {
            tool: resolution.tool,
            source: resolution.source,
            reason: `Homebrew has no bottle of ${resolution.source.formula}, or of a dependency, for this architecture`,
          },
        ]
      : [],
  );
}

/**
 * names the formula a resolution picked, if it picked one
 * @param resolution a tool's resolution
 * @returns the formula, or nothing
 */
function formulaOf(resolution: Resolution): string[] {
  return 'source' in resolution && resolution.source.kind === 'brew'
    ? [resolution.source.formula]
    : [];
}
