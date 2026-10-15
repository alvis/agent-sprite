import { TOOL_LINK_DIRECTORY } from '../homebrew.js';
import { isRecord } from '../records.js';
import { versionProbe } from '../system-probes.js';

import { probeVersion, versionOf } from './agent.js';

import type { ReleaseInstallTools } from '../../drivers/install-sources.js';
import type { HomebrewTool } from '../homebrew.js';

import type { BottleTag, Homebrew } from './homebrew.js';
import type { ComponentInstall, ResolvedRelease } from './ledger.js';

/** a formula as Homebrew names it, with what installing it takes */
interface Keg {
  /** Homebrew's description of the formula */
  described: Record<string, unknown>;
  /** the formula's own name, which an alias such as `python3` resolves to */
  name: string;
  /** the formula and every formula it depends on, by their own names */
  closure: string[];
}

/**
 * describes a tool poured from its Homebrew bottle and linked at stable
 * paths in `/usr/local/bin`. Homebrew reports the latest version, so no release
 * feed is read. A formula may be an alias that follows the current release,
 * such as `python3`; the ledger keeps the alias as the component's key, while
 * Homebrew is asked for the formula the alias resolves to, so a new release
 * line is installed beside the old one and the keg's `opt` link follows it.
 * The tool counts as current only when neither its keg nor any formula it
 * depends on is outdated, so a new revision of the tool or a fixed library it
 * links, such as OpenSSL or curl, is poured even while the tool's own version
 * stays the same
 * @param tools installer helpers core lends
 * @param homebrew Homebrew for this run
 * @param tool the formula, the commands it links and the one that reports its version
 * @returns how the ledger resolves, probes and installs the tool
 */
export function formulaComponent(
  tools: ReleaseInstallTools,
  homebrew: Homebrew,
  tool: HomebrewTool,
): ComponentInstall<ResolvedRelease> {
  const { formula } = tool;
  const link = `${TOOL_LINK_DIRECTORY}/${tool.command}`;
  let keg: Promise<Keg> | undefined;
  const kegOfTool = async (): Promise<Keg> => {
    keg ??= kegOf(homebrew, formula);

    return keg;
  };

  return {
    component: formula,
    resolve: async () => {
      await homebrew.ready();
      const { described } = await kegOfTool();

      return { version: stableOf(described, formula) };
    },
    // the linked tool, read as the agent that uses it; a copy from anywhere
    // but the prefix is not this component
    installed: async () => {
      if (!(await homebrew.owns(link))) {
        return undefined;
      }
      const version = await probeVersion(tools.run, versionProbe(tool));
      const outdated = await outdatedOf(homebrew, (await kegOfTool()).closure);

      return version && outdated.length > 0
        ? `${version} with ${outdated.join(', ')} outdated`
        : version;
    },
    install: async () => {
      const { name, closure } = await kegOfTool();
      assertBottles(await formulae(homebrew, closure), homebrew.bottle);
      if (await homebrew.has(name)) {
        const outdated = await outdatedOf(homebrew, closure);
        await homebrew.run([
          'upgrade',
          ...(outdated.length > 0 ? outdated : [name]),
        ]);
      } else {
        await homebrew.run(['install', name]);
      }
      await linkCommands(tools, homebrew, tool);
    },
  };
}

/**
 * links each command the tool provides from its keg's `opt` link, which
 * Homebrew keeps for every installed keg, even one that is keg-only
 * @param tools installer helpers core lends
 * @param homebrew Homebrew for this run
 * @param tool the formula and the commands it links
 * @throws {Error} when the keg lacks a command the tool names or holds none
 */
async function linkCommands(
  tools: ReleaseInstallTools,
  homebrew: Homebrew,
  tool: HomebrewTool,
): Promise<void> {
  for (const { directory, commands } of tool.links) {
    const source = `${homebrew.layout.prefix}/opt/${tool.formula}/${directory}`;
    const names = commands ?? (await homebrew.entries(source));
    if (names.length === 0) {
      throw new Error(`${tool.formula} provides no commands in ${directory}`);
    }
    for (const name of names) {
      const target = `${source}/${name}`;
      if (!(await homebrew.owns(target))) {
        throw new Error(`${tool.formula} provides no ${name}`);
      }
      await tools.link(target, `${TOOL_LINK_DIRECTORY}/${name}`);
    }
  }
}

/**
 * reads a formula, which may be an alias, as Homebrew names and describes it
 * @param homebrew Homebrew for this run
 * @param formula formula name or alias
 * @returns the formula, with its dependencies
 * @throws {Error} when Homebrew gives the formula no name
 */
async function kegOf(homebrew: Homebrew, formula: string): Promise<Keg> {
  const [described = {}] = await formulae(homebrew, [formula]);
  const { name } = described;
  if (typeof name !== 'string') {
    throw new Error(`Homebrew names no formula for ${formula}`);
  }

  return {
    described,
    name,
    closure: [name, ...(await dependenciesOf(homebrew, name))],
  };
}

/**
 * lists a formula's recursive runtime dependencies
 * @param homebrew Homebrew for this run
 * @param formula formula name
 * @returns the dependencies' names
 */
async function dependenciesOf(
  homebrew: Homebrew,
  formula: string,
): Promise<string[]> {
  return (await homebrew.run(['deps', formula], true))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * lists which of some formulae Homebrew has a newer stable version of than
 * the one installed; formulae not installed are not outdated
 * @param homebrew Homebrew for this run
 * @param names formula names
 * @returns the outdated formulae among them
 */
async function outdatedOf(
  homebrew: Homebrew,
  names: readonly string[],
): Promise<string[]> {
  // every installed formula, since brew refuses to name one that is not
  const report: unknown = JSON.parse(
    await homebrew.run(['outdated', '--json=v2'], true),
  );
  const listed =
    isRecord(report) && Array.isArray(report.formulae) ? report.formulae : [];

  return listed
    .filter(isRecord)
    .map(({ name }) => name)
    .filter(
      (name): name is string =>
        typeof name === 'string' && names.includes(name),
    );
}

/**
 * reads formulae as Homebrew describes them
 * @param homebrew Homebrew for this run
 * @param names formula names
 * @returns one description per name, in Homebrew's order
 * @throws {Error} when Homebrew describes another number of formulae
 */
async function formulae(
  homebrew: Homebrew,
  names: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const info: unknown = JSON.parse(
    await homebrew.run(['info', '--json=v2', ...names], true),
  );
  const listed =
    isRecord(info) && Array.isArray(info.formulae) ? info.formulae : [];
  const described = listed.filter(isRecord);
  if (described.length !== names.length) {
    throw new Error('Homebrew did not describe every formula');
  }

  return described;
}

/**
 * reads a formula's stable version
 * @param formula Homebrew's description of the formula
 * @param name the formula's name
 * @returns the dotted stable version
 * @throws {Error} when the description has none
 */
function stableOf(
  formula: Record<string, unknown> | undefined,
  name: string,
): string {
  const versions = formula?.versions;
  const stable =
    isRecord(versions) && typeof versions.stable === 'string'
      ? versionOf(versions.stable)
      : undefined;
  if (!stable) {
    throw new Error(`Homebrew lists no stable ${name} version`);
  }

  return stable;
}

/**
 * refuses to install when any formula lacks a bottle for this platform,
 * since Homebrew would otherwise build it from source
 * @param described formulae as Homebrew describes them
 * @param tag this workstation's bottle platform
 * @throws {Error} naming every formula without a bottle
 */
function assertBottles(
  described: ReadonlyArray<Record<string, unknown>>,
  tag: BottleTag,
): void {
  const unbottled = described
    .filter((formula) => {
      const { bottle } = formula;
      const stable = isRecord(bottle) ? bottle.stable : undefined;
      const files = isRecord(stable) ? stable.files : undefined;

      return !isRecord(files) || !(tag in files || 'all' in files);
    })
    .map(({ name }) => (typeof name === 'string' ? name : 'unnamed'));
  if (unbottled.length > 0) {
    throw new Error(
      `No ${tag} bottle for ${unbottled.join(', ')}; refusing to build from source`,
    );
  }
}
