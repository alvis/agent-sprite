import { catalog } from '#core/catalog';
import { harnessDrivers } from '#core/harnesses';
import { networkDriver } from '#core/networks';
import { SYSTEM_PROBES } from '#guest/system-probes';

import { runAsAgent } from './account.js';

import type { AgentId, HarnessId, NetworkId } from '#core/catalog';
import type { GuestChannel } from '#drivers/guest-channel';
import type { ToolSpec } from '#tools/contracts';

/** selected agent, harnesses and network whose versions are probed */
export interface InstalledVersionSelection {
  /** selected ACP agent */
  agent: AgentId;
  /** selected harnesses */
  harnesses: readonly HarnessId[];
  /** selected network, whose tool is probed when it installs one */
  network: NetworkId;
}

/**
 * queries installed guest tool versions without changing guest state
 * @param guest target guest
 * @param selection selected agent, harnesses and network whose versions are probed
 * @returns installed tool versions keyed by tool name
 */
export async function readInstalledVersions(
  guest: GuestChannel,
  selection: InstalledVersionSelection,
): Promise<Record<string, string>> {
  const agent = catalog.agents[selection.agent];
  const probes = [
    ...SYSTEM_PROBES,
    ...networkDriver(selection.network).tools.map(probe),
    ...harnessDrivers(selection.harnesses).flatMap(({ tools, acpAdapter }) =>
      [...tools, ...(acpAdapter ? [acpAdapter.tool] : [])].map(probe),
    ),
    ...agent.tools.map(probe),
  ];
  const entries = await Promise.all(
    probes.map(async ([name, argv]) => {
      const result = await runAsAgent(guest, [...argv]);

      return [name, result.stdout.trim()] as const;
    }),
  );

  return Object.fromEntries(entries);
}

/**
 * names the probe that reports one tool's installed version
 * @param tool the tool's declaration
 * @returns the tool's name and the program and arguments that report its version
 */
function probe(tool: ToolSpec): readonly [string, string[]] {
  return [tool.name, [tool.version.executable, ...tool.version.args]];
}
