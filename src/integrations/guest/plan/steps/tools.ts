import {
  HOMEBREW_LIBRARY,
  LINKS_LIBRARY,
  NPM_LIBRARY,
  RUSTUP_LIBRARY,
} from '#tools/libraries';

import { libraryCommand } from './library.js';

import type { GuestAsset, OsFamily } from '#os/contracts';
import type {
  BrewToolSource,
  Resolution,
  SystemToolSource,
  ToolSource,
  ToolSpec,
  ToolVersionProbe,
} from '#tools/contracts';

import type { SetupStep, StepCommand } from '../contracts.js';

import type { LibraryCall } from './library.js';

/** longest one command of a formula's step may take: a large formula pours many bottles */
const BREW_LIMIT_MS = 1_800_000;
/** longest one command of a system package step may take, its lock wait included */
const SYSTEM_LIMIT_MS = 1_200_000;
/** longest one command of an npm tool's step may take */
const NPM_LIMIT_MS = 900_000;
/** longest one command of a Rust toolchain's step may take */
const RUSTUP_LIMIT_MS = 1_200_000;

/** what every tool step is built with */
export interface ToolStepContext {
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
export function toolStepId(tool: string): string {
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
    check: actions.check ? command(actions.check) : probeCommand(spec.version),
    apply: command(actions.apply),
    verify: probeCommand(spec.version),
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
      return {
        libraries: [NPM_LIBRARY],
        apply: [['oa_npm_install', source.package, source.distTag ?? 'latest']],
        timeoutMs: NPM_LIMIT_MS,
      };
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
 * renders a tool's version probe as a step command
 * @param probe the executable, arguments, account and environment that print the version
 * @returns the command, run as the probe's account
 */
export function probeCommand(probe: ToolVersionProbe): StepCommand {
  return {
    argv: [probe.executable, ...probe.args],
    account: probe.account,
    ...(probe.environment ? { environment: probe.environment } : {}),
  };
}
