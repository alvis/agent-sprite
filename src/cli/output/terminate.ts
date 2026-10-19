import { projectFields, same } from './fields';
import { projectMachine } from './machine';

import type { TerminateData } from '#application/data';

import type { MachineOutput } from './machine';

/** a deleted workstation and the separately observed network cleanup */
export interface TerminateDataOutput {
  machine: MachineOutput;
  workstation: { status: 'deleted'; id: string; name: string };
  network: {
    status: string;
    deviceId?: string;
    address?: string;
  };
}

/**
 * projects the termination result
 * @param data internal result
 * @returns output result
 */
export function projectTerminate(data: TerminateData): TerminateDataOutput {
  return projectFields<TerminateData, TerminateDataOutput>(data, {
    machine: projectMachine,
    workstation: (workstation) =>
      projectFields<typeof workstation, TerminateDataOutput['workstation']>(
        workstation,
        { status: same, id: same, name: same },
      ),
    network: (network) =>
      projectFields<typeof network, TerminateDataOutput['network']>(network, {
        status: same,
        deviceId: same,
        address: same,
      }),
  });
}
