import { HOMEBREW_PATH, SESSION_PATH } from '#adapters/guest/platform/layout';
import { libraryCommand } from '#adapters/guest/platform/library';
import {
  HOMEBREW_LIBRARY,
  LINKS_LIBRARY,
  NPM_LIBRARY,
  RUSTUP_LIBRARY,
  VERSIONS_LIBRARY,
} from '#adapters/guest/tools/libraries';

import type { LibraryCall } from '#adapters/guest/platform/library';
import type { OsFamily } from '#application/ports/os';
import type { SetupStep, StepCommand } from '#application/ports/plan';
import type { GuestAsset } from '#domain/guest';
import type {
  BrewToolSource,
  NpmToolSource,
  Resolution,
  SystemToolSource,
  ToolSource,
  ToolSpec,
  ToolVersionProbe,
} from '#domain/tools';

/** longest one command of a formula's step may take: a large formula pours many bottles */
const BREW_LIMIT_MS = 1_800_000;
/** longest one command of a system package step may take, its lock wait included */
const SYSTEM_LIMIT_MS = 1_200_000;
/** longest one command of an npm tool's step may take */
const NPM_LIMIT_MS = 900_000;
/** longest one command of a Rust toolchain's step may take */
const RUSTUP_LIMIT_MS = 1_200_000;
/** longest the record of the tools' versions may take: npm, rustup and Homebrew each start once per tool */
const VERSIONS_LIMIT_MS = 300_000;

/** id of the step that records each tool's installed version in environment.json */
const VERSIONS_STEP = 'tool-versions';

/** what every tool step is built with */
interface ToolStepContext {
  /** the guest's OS family, whose shell and library every step uses */
  family: Pick<OsFamily, 'shell' | 'library'>;
  /** id of the step that installs Homebrew, which every formula's step needs */
  homebrewStep: string;
  /** ids of steps every tool step needs, such as the bootstrap packages */
  needs?: readonly string[];
}

/**
 * names the step that installs a tool
 * @param tool the tool's name
 * @returns the name prefixed with `tool:`
 */
function toolStepId(tool: string): string {
  return `tool:${tool}`;
}

/**
 * turns each resolved tool into the step that installs it: a step's check
 * tells whether its source already installed it, its apply installs it with
 * the source's manager and its verify runs the tool's version probe. A tool
 * with no usable source has no step; setup records it instead
 * @param resolutions the source picked for each tool
 * @param tools the tools the resolutions are for
 * @param context the family, the Homebrew step and the steps every tool needs
 * @returns one step per installable tool
 * @throws {Error} when a resolution names a tool not given
 */
export function toolSteps(
  resolutions: readonly Resolution[],
  tools: readonly ToolSpec[],
  context: ToolStepContext,
): SetupStep[] {
  const specs = new Map(tools.map((tool) => [tool.name, tool]));

  return resolutions.flatMap((resolution) => {
    if ('unavailable' in resolution) {
      return [];
    }
    const spec = specs.get(resolution.tool);
    if (!spec) {
      throw new Error(`No tool ${resolution.tool} was declared`);
    }

    return [toolStep(spec, resolution.source, context)];
  });
}

/**
 * builds the step that records in environment.json the version each tool's
 * manager reports installed; it has no check, so every setup records what
 * the guest has now, and the plan lists it after every tool step, so it
 * follows them, without needing them, since an optional tool that failed
 * still has its peers' versions to record
 * @param family the guest's OS family, whose shell and library it uses
 * @param params the record's path and the steps it needs, such as the one writing the record
 * @param params.path absolute guest path of environment.json
 * @param params.needs ids of the steps the record needs
 * @returns a critical root step
 */
export function versionsStep(
  family: Pick<OsFamily, 'shell' | 'library'>,
  params: { path: string; needs: readonly string[] },
): SetupStep {
  return {
    id: VERSIONS_STEP,
    component: 'environment',
    account: 'root',
    needs: [...params.needs],
    apply: libraryCommand(
      family.shell,
      [
        family.library,
        HOMEBREW_LIBRARY,
        NPM_LIBRARY,
        RUSTUP_LIBRARY,
        VERSIONS_LIBRARY,
      ],
      [['oa_tools_record_versions', params.path]],
    ),
    timeoutMs: VERSIONS_LIMIT_MS,
    critical: true,
    retry: 'transport',
  };
}

/**
 * builds the step that installs a tool from its resolved source
 * @param spec the tool's declaration
 * @param source the source resolved for it
 * @param context the family, the Homebrew step and the steps every tool needs
 * @returns a root step, critical when the tool is required
 */
function toolStep(
  spec: ToolSpec,
  source: ToolSource,
  context: ToolStepContext,
): SetupStep {
  const { family, homebrewStep, needs = [] } = context;
  const actions = sourceActions(spec, source);
  const probe = probeCommand(
    source.kind === 'brew' ? homebrewProbe(spec.version) : spec.version,
  );
  const command = (calls: readonly LibraryCall[]): StepCommand =>
    libraryCommand(family.shell, [family.library, ...actions.libraries], calls);

  return {
    id: toolStepId(spec.name),
    component: spec.name,
    account: 'root',
    needs: [
      ...needs,
      ...(source.kind === 'brew' ? [homebrewStep] : []),
      ...(spec.needs ?? []).map(toolStepId),
    ],
    check: actions.check ? command(actions.check) : probe,
    apply: command(actions.apply),
    verify: probe,
    timeoutMs: actions.timeoutMs,
    critical: spec.required,
    retry: 'transport',
  };
}

/** the library calls a source's step makes */
interface SourceActions {
  /** libraries sourced after the family's */
  libraries: readonly GuestAsset[];
  /** calls that tell whether the tool is in place; the version probe when absent */
  check?: readonly LibraryCall[];
  /** calls that install the tool */
  apply: readonly LibraryCall[];
  /** limit of each of the step's commands */
  timeoutMs: number;
}

/**
 * decides the library calls that check and install a tool from its source
 * @param spec the tool's declaration
 * @param source the source resolved for it
 * @returns the libraries, calls and limit of the step
 */
function sourceActions(spec: ToolSpec, source: ToolSource): SourceActions {
  switch (source.kind) {
    case 'brew':
      return brewActions(spec, source);
    case 'system':
      return systemActions(source);
    case 'npm':
      return npmActions(source);
    case 'rustup':
      return {
        libraries: [RUSTUP_LIBRARY],
        check: [
          ['oa_rustup_installed', source.toolchain, ...source.components],
        ],
        apply: [['oa_rustup_install', source.toolchain, ...source.components]],
        timeoutMs: RUSTUP_LIMIT_MS,
      };
    default:
      throw new Error(`Tool ${spec.name} has a source of no known kind`);
  }
}

/**
 * decides the calls of a formula's step: pour its bottle, then link the
 * executables the tool lists; it is in place once installed and linked
 * @param spec the tool's declaration
 * @param source the formula
 * @returns the libraries, calls and limit of the step
 */
function brewActions(spec: ToolSpec, source: BrewToolSource): SourceActions {
  const link = (mode: string): LibraryCall => [
    'oa_link_tool',
    mode,
    source.formula,
    (source.binDirs ?? ['bin']).join(' '),
    spec.executables.join(' '),
  ];

  return {
    libraries: [HOMEBREW_LIBRARY, LINKS_LIBRARY],
    check: [['oa_brew_installed', source.formula], link('check')],
    apply: [
      ['oa_brew_install', source.formula, ...(source.tap ? [source.tap] : [])],
      link('apply'),
    ],
    timeoutMs: BREW_LIMIT_MS,
  };
}

/**
 * decides the calls of an npm package's step: install it at its dist-tag. A
 * package pinned to a dist-tag, such as an agent's release channel, is in
 * place only once its installed version is the one the tag names now, since
 * any installed version passes the tool's version probe; one without a tag
 * is in place once the probe passes
 * @param source the package
 * @returns the libraries, calls and limit of the step
 */
function npmActions(source: NpmToolSource): SourceActions {
  return {
    libraries: [NPM_LIBRARY],
    ...(source.distTag
      ? { check: [['oa_npm_current', source.package, source.distTag]] }
      : {}),
    apply: [['oa_npm_install', source.package, source.distTag ?? 'latest']],
    timeoutMs: NPM_LIMIT_MS,
  };
}

/**
 * decides the calls of a system package step: mask the vendor services, add
 * the signed repository, then install the packages; it is in place once every
 * package is installed
 * @param source the packages
 * @returns the libraries, calls and limit of the step
 * @throws {Error} when the repository has no entry for the source's family
 */
function systemActions(source: SystemToolSource): SourceActions {
  const { packages, repository, vendorServices = [] } = source;
  const prepare: LibraryCall[] = [];
  if (vendorServices.length > 0) {
    prepare.push(['oa_mask_service', ...vendorServices]);
  }
  if (repository) {
    const entry = repository[source.family];
    if (!entry) {
      throw new Error(
        `Repository ${repository.id} has no ${source.family} entry`,
      );
    }
    prepare.push([
      'oa_repo_add',
      repository.id,
      repository.key.url,
      repository.key.fingerprints.join(' '),
      entry.uri,
      entry.suite,
      ...entry.components,
    ]);
  }

  return {
    libraries: [],
    check: [['oa_pkg_installed', ...packages]],
    apply: [...prepare, ['oa_pkg_install', ...packages]],
    timeoutMs: SYSTEM_LIMIT_MS,
  };
}

/**
 * points a formula's version probe at Homebrew's own executables, which the
 * session's PATH searches only after the system's, unless the probe names
 * its PATH itself
 * @param probe the formula's version probe
 * @returns the probe, with Homebrew's directories first on its PATH
 */
function homebrewProbe(probe: ToolVersionProbe): ToolVersionProbe {
  return {
    ...probe,
    environment: {
      PATH: `${HOMEBREW_PATH}:${SESSION_PATH}`,
      ...probe.environment,
    },
  };
}

/**
 * renders a tool's version probe as a step command
 * @param probe the executable, arguments, account and environment that print the version
 * @returns the command, run as the probe's account
 */
function probeCommand(probe: ToolVersionProbe): StepCommand {
  return {
    argv: [probe.executable, ...probe.args],
    account: probe.account,
    ...(probe.environment ? { environment: probe.environment } : {}),
  };
}
