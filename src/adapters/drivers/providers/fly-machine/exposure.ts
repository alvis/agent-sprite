import { ProviderFault } from '#kernel/provider-fault';

import { declaresAgentService } from './machine-config';
import { PUBLIC_IP_TYPES } from './wire';

import type { ExposureVisibility } from '#domain/declarations';

import type { FlyApi } from './api';
import type { FlyMachine } from './wire';

/** one machine and who may reach its service */
interface ExposureParams {
  /** authenticated Machines API client */
  api: FlyApi;
  /** app name, which is the workstation name */
  app: string;
  /** the machine as observed before the change */
  machine: FlyMachine;
  /** ACP agent port the declared service routes */
  port: number;
  /** who may reach the URL */
  visibility: ExposureVisibility;
}

/**
 * assigns or releases the public addresses the Fly proxy routes to the
 * service declared at creation; changing the service itself would restart
 * the machine, so exposure only touches the app's addresses
 * @param params client, app, observed machine, port and visibility
 * @throws {ProviderFault} failed when the machine declares no service for the port
 */
export async function applyExposure(params: ExposureParams): Promise<void> {
  const { api, app, machine, port, visibility } = params;
  const assigned = await api.listIps(app);
  if (visibility === 'private') {
    for (const { ip, type } of assigned) {
      if (PUBLIC_IP_TYPES.has(type)) {
        await api.releaseIp(app, ip);
      }
    }

    return;
  }
  if (!declaresAgentService(machine.routes, port)) {
    throw new ProviderFault({
      code: 'failed',
      message: `Fly machine of ${app} declares no auto-starting service for port ${port}`,
    });
  }
  if (!assigned.some(({ type }) => type === 'v6')) {
    await api.assignIp(app, 'v6');
  }
  if (!assigned.some(({ type }) => type === 'shared_v4')) {
    await api.assignIp(app, 'shared_v4');
  }
}
