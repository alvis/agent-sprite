import { installWorkstation } from '#application/installation/install';
import { traceStage } from '#kernel/operation';

import type { InstallParams } from '#application/installation/install';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { GuestEnvironment } from '#domain/observations/environment';

import type { SetupContext } from './context';

/**
 * runs the workstation's setup plan for the profile this run applies,
 * carrying over the device identity and services the guest recorded; the
 * record stays `incomplete` until the caller marks the installation ready
 * @param dependencies the guest mechanics
 * @param context provider, setup session, profile, prompts and mutation state
 * @param beforeServices runs once the tools and environment.json are in place and before any service starts
 * @returns the environment the plan recorded
 */
export async function installSetupPlan(
  dependencies: Pick<ApplicationDependencies, 'guest'>,
  context: Pick<
    SetupContext,
    'provider' | 'connection' | 'profile' | 'interaction' | 'mutation'
  >,
  beforeServices?: InstallParams['beforeServices'],
): Promise<GuestEnvironment> {
  const { provider, connection, profile, interaction, mutation } = context;
  const previous = await dependencies.guest.environment.find(
    await connection.guest(),
  );
  mutation.started = true;

  return traceStage('setup.install', async () =>
    installWorkstation(dependencies.guest, {
      provider,
      connection,
      profile,
      ...(previous ? { previous } : {}),
      interaction,
      beforeServices,
    }),
  );
}
