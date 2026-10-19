import { each, projectFields, same } from './fields';
import { machineFields } from './machine';

import type { ListData, UnavailableProvider } from '#application/data';

import type { MachineOutput } from './machine';

/** a workstation merged into the list across providers */
export interface ListMachineOutput extends MachineOutput {
  provider: string;
  newerRelease?: string;
}

/** a provider that could not be queried */
export interface UnavailableProviderOutput {
  provider: string;
  code: string;
  reason: string;
}

/** the live list merged across every provider with credentials */
export interface ListDataOutput {
  machines: ListMachineOutput[];
  unavailable: UnavailableProviderOutput[];
}

type ListMachine = ListData['machines'][number];

/**
 * projects one listed workstation
 * @param machine internal list entry
 * @returns output list entry
 */
function projectListMachine(machine: ListMachine): ListMachineOutput {
  return projectFields<ListMachine, ListMachineOutput>(machine, {
    ...machineFields,
    provider: same,
    newerRelease: same,
  });
}

/**
 * projects a provider that could not be queried
 * @param provider internal entry
 * @returns output entry
 */
function projectUnavailable(
  provider: UnavailableProvider,
): UnavailableProviderOutput {
  return projectFields<UnavailableProvider, UnavailableProviderOutput>(
    provider,
    {
      provider: same,
      code: same,
      reason: same,
    },
  );
}

/**
 * projects the merged list
 * @param data internal list
 * @returns output list
 */
export function projectList(data: ListData): ListDataOutput {
  return projectFields<ListData, ListDataOutput>(data, {
    machines: each(projectListMachine),
    unavailable: each(projectUnavailable),
  });
}
