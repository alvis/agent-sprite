import { catalog } from '#core/catalog';
import { harnessDrivers } from '#core/harnesses';
import { networkDriver } from '#core/networks';
import { SYSTEM_PROBES } from '#guest/system-probes';

import { runAsAgent } from './account.js';

import type { AgentId, HarnessId, NetworkId } from '#core/catalog';
import type { InstallSpec } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

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
  const { install } = networkDriver(selection.network);
  const probes = [
    ...SYSTEM_PROBES,
    ...(install ? [probe(install)] : []),
    ...harnessDrivers(selection.harnesses).flatMap(
      ({ install, acpAdapter }) => [
        probe(install),
        ...(acpAdapter ? [probe(acpAdapter.install)] : []),
      ],
    ),
    probe(agent.install),
    probe(agent.runtime),
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
 * names the probe that reports one component's installed version
 * @param install the component's install spec
 * @returns the component key and the program and arguments that report its version
 */
function probe(install: InstallSpec): readonly [string, string[]] {
  return [
    install.component,
    [install.versionProbe.program, ...install.versionProbe.arguments],
  ];
}
