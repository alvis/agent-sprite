import { CommandFault } from '#errors';

import type { OsConstraint, OsFamily, OsRelease } from '#os/contracts';

import type { Resolution, ToolSource, ToolSpec } from './contracts.js';

/** the guest a resolution is for */
interface ResolutionTarget {
  /** the guest's release */
  release: OsRelease;
  /** the guest's OS family */
  family: Pick<OsFamily, 'id' | 'homebrew'>;
}

/** a source the guest turned down after resolution, such as a formula with no bottle for its architecture */
export interface RefusedSource {
  /** tool name */
  tool: string;
  /** the source turned down */
  source: ToolSource;
  /** why, as reported to the user */
  reason: string;
}

/**
 * picks, for every tool, the first source usable on the guest: one whose
 * family, distribution, architecture and C library match, that Homebrew can
 * serve when it is a formula, that the guest has not turned down, and whose
 * needed tools resolved too. A source the guest turns down at setup time,
 * such as a formula whose bottle is missing, is passed back as refused so
 * resolving again falls through to the next source
 * @param tools the tools, each with its sources in preference order
 * @param target the guest's release and OS family
 * @param refused sources the guest turned down
 * @returns a resolution per tool, in the order given
 * @throws {CommandFault} when a required tool has no usable source
 * @throws {Error} when two tools share a name or the needs form a cycle
 */
export function resolveTools(
  tools: readonly ToolSpec[],
  target: ResolutionTarget,
  refused: readonly RefusedSource[] = [],
): Resolution[] {
  const { release } = target;
  const specs = new Map<string, ToolSpec>();
  for (const tool of tools) {
    if (specs.has(tool.name)) {
      throw new Error(`Two tools are named ${tool.name}`);
    }
    specs.set(tool.name, tool);
  }
  const resolved = new Map<string, Resolution>();
  const resolving = new Set<string>();
  const resolve = (tool: ToolSpec): Resolution => {
    const known = resolved.get(tool.name);
    if (known) {
      return known;
    }
    if (resolving.has(tool.name)) {
      throw new Error(`The needs of ${tool.name} form a cycle`);
    }
    resolving.add(tool.name);
    const missing = (tool.needs ?? []).map((name) => {
      const needed = specs.get(name);
      if (!needed) {
        return `it needs ${name}, which no tool provides`;
      }
      const resolution = resolve(needed);

      return 'unavailable' in resolution
        ? `it needs ${name}, which is unavailable`
        : undefined;
    });
    const resolution = pick(tool, missing.find(Boolean), {
      ...target,
      refused,
    });
    resolving.delete(tool.name);
    resolved.set(tool.name, resolution);

    return resolution;
  };
  const resolutions = tools.map(resolve);
  const refusals = resolutions.flatMap((resolution) =>
    'unavailable' in resolution && specs.get(resolution.tool)?.required
      ? [`${resolution.tool}: ${resolution.unavailable}`]
      : [],
  );
  if (refusals.length > 0) {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message: `Setup cannot install the tools ${describe(release)} needs`,
      details: refusals,
    });
  }

  return resolutions;
}

/** what a source is judged against */
interface SourceContext extends ResolutionTarget {
  /** sources the guest turned down */
  refused: readonly RefusedSource[];
}

/**
 * picks a tool's first usable source
 * @param tool the tool whose sources are tried in order
 * @param missingNeed why a tool it needs is unavailable, if one is
 * @param context the release, family and refused sources
 * @returns the source, or why none is usable
 */
function pick(
  tool: ToolSpec,
  missingNeed: string | undefined,
  context: SourceContext,
): Resolution {
  if (missingNeed !== undefined) {
    return { tool: tool.name, unavailable: missingNeed };
  }
  const reasons: string[] = [];
  for (const source of tool.sources) {
    const reason = unusable(tool.name, source, context);
    if (reason === undefined) {
      return { tool: tool.name, source };
    }
    reasons.push(reason);
  }

  return { tool: tool.name, unavailable: reasons.join('; ') };
}

/**
 * tells why a source is not usable on the guest
 * @param name the tool's name
 * @param source one of the tool's sources
 * @param context the release, family and refused sources
 * @returns the reason, or nothing when the source is usable
 */
function unusable(
  name: string,
  source: ToolSource,
  context: SourceContext,
): string | undefined {
  const { release, family, refused } = context;
  const turnedDown = refused.find(
    (refusal) =>
      refusal.tool === name &&
      JSON.stringify(refusal.source) === JSON.stringify(source),
  );
  if (turnedDown) {
    return turnedDown.reason;
  }
  if (source.kind === 'brew') {
    const support = family.homebrew(release);

    return (
      mismatch(source.when, release) ??
      (support.supported ? undefined : support.reason)
    );
  }
  if (source.kind === 'system') {
    return mismatch({ ...source.when, families: [source.family] }, release);
  }

  // npm and rustup sources are usable wherever the tool they need is
  return undefined;
}

/**
 * tells why a release falls outside a source's constraint
 * @param when the constraint; absent matches every release
 * @param release the guest's release
 * @returns the reason, or nothing when the release matches
 */
function mismatch(
  when: OsConstraint | undefined,
  release: OsRelease,
): string | undefined {
  if (when?.families && !when.families.includes(release.family)) {
    return `it is not for the ${release.family} family`;
  }
  if (when?.ids && !when.ids.includes(release.id)) {
    return `it is not for ${release.id}`;
  }
  if (when?.arch && !when.arch.includes(release.arch)) {
    return `it is not for ${release.arch}`;
  }
  if (when?.libc && when.libc !== release.libc) {
    return `it is not for ${release.libc}`;
  }

  return undefined;
}

/**
 * names a release the way a refusal reports it
 * @param release the guest's release
 * @returns the distribution, release and architecture
 */
function describe(release: OsRelease): string {
  return `${release.id} ${release.versionId} (${release.arch})`;
}
