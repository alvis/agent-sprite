import { findGuestEnvironment } from '#integrations/guest/environment/store';
import { installWorkstation } from '#integrations/guest/install';
import { traceStage } from '#operation';

import type { GuestEnvironment } from '#integrations/guest/environment/contracts';
import type { InstallParams } from '#integrations/guest/install';

import type { SetupContext } from './context.js';

/**
 * runs the workstation's setup plan for the profile this run applies,
 * carrying over the device identity and services the guest recorded; the
 * record stays `incomplete` until the caller marks the installation ready
 * @param context provider, setup session, profile, prompts and mutation state
 * @param beforeServices runs once the tools and environment.json are in place and before any service starts
 * @returns the environment the plan recorded
 */
export async function installSetupPlan(
  context: Pick<
    SetupContext,
    'provider' | 'connection' | 'profile' | 'interaction' | 'mutation'
  >,
  beforeServices?: InstallParams['beforeServices'],
): Promise<GuestEnvironment> {
  const { provider, connection, profile, interaction, mutation } = context;
  const previous = await findGuestEnvironment(await connection.guest());
  mutation.started = true;

  return traceStage('setup.install', async () =>
    installWorkstation({
      provider,
      connection,
      profile,
      ...(previous ? { previous } : {}),
      interaction,
      beforeServices,
    }),
  );
}
