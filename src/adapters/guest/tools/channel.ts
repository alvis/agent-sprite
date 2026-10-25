import { familyOf } from '#adapters/guest/os/families';
import { libraryCommand } from '#adapters/guest/platform/library';
import { selectedChannel } from '#domain/release-channels';

import { NPM_LIBRARY } from './libraries';

import type { AgentDriver, DriverRegistry } from '#application/ports/drivers';
import type { AgentReleaseState } from '#application/ports/guest';
import type { SetupSession } from '#application/ports/session';
import type { WorkstationProfile } from '#domain/profile';
import type { ToolSpec } from '#domain/tools';

/** longest the read of the agent's release may take: npm asks the registry */
const RELEASE_READ_LIMIT_MS = 120_000;

/**
 * the agent's own CLI, its first tool, with each npm source pinned to the
 * dist-tag of the release channel the workstation follows; the plan installs
 * it so and setup reads its release from the same source
 * @param agent the agent's driver
 * @param release the channel the workstation records, absent for the default
 * @returns the CLI, pinned when the agent declares the channel; nothing when the agent has no tools
 */
export function agentCli(
  agent: Pick<AgentDriver, 'tools' | 'releaseChannels'>,
  release: string | undefined,
): ToolSpec | undefined {
  const [cli] = agent.tools;
  const channel = selectedChannel(agent.releaseChannels, release);
  if (!cli || !channel) {
    return cli;
  }
  const [first, ...rest] = cli.sources.map((source) =>
    source.kind === 'npm' ? { ...source, distTag: channel.distTag } : source,
  );

  return first ? { ...cli, sources: [first, ...rest] } : cli;
}

/**
 * reads the version of the agent's own CLI the guest has installed and the
 * one its release channel's npm dist-tag names now, through the guest's npm
 * library
 * @param registry every registered driver
 * @param session the setup session, opened when it is not
 * @param profile the selection, whose agent and release channel are read
 * @returns both versions; untracked when the CLI follows no channel on npm, unknown with the guest's reason when the registry could not be asked
 */
export async function inspectAgentRelease(
  registry: Pick<DriverRegistry, 'agents'>,
  session: SetupSession,
  profile: WorkstationProfile,
): Promise<AgentReleaseState> {
  const source = agentCli(
    registry.agents[profile.agent],
    profile.options.agentRelease,
  )?.sources.find(({ kind }) => kind === 'npm');
  if (source?.kind !== 'npm' || !source.distTag) {
    return { status: 'untracked' };
  }
  const { release } = await session.open();
  const family = familyOf(release);
  const { exitCode, stdout, stderr } = await session.run({
    ...libraryCommand(
      family.shell,
      [family.library, NPM_LIBRARY],
      [['oa_npm_release', source.package, source.distTag]],
    ),
    account: 'root',
    timeoutMs: RELEASE_READ_LIMIT_MS,
  });
  const lines = new Map(
    stdout.split('\n').flatMap((line) => {
      const separator = line.indexOf('=');

      return separator > 0
        ? [[line.slice(0, separator), line.slice(separator + 1).trim()]]
        : [];
    }),
  );
  const tagged = lines.get('tagged');
  if (exitCode !== 0 || !tagged) {
    // npm ends every failure with the path of its debug log, so the cause is
    // the error code line, or failing that the first error line
    const errors = stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('npm error'));
    const reason =
      errors.find((line) => line.startsWith('npm error code ')) ??
      errors[0] ??
      stderr.trim().split('\n')[0]?.trim() ??
      '';

    return {
      status: 'unknown',
      reason:
        reason === ''
          ? `npm could not read ${source.package}@${source.distTag} (exit ${String(exitCode)})`
          : reason,
    };
  }
  const installed = lines.get('installed');

  return {
    status: 'known',
    tagged,
    ...(installed ? { installed } : {}),
  };
}
