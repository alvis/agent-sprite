import { CRON_LIBRARY, jobsStep } from './cron';
import { runitBackend } from './runit/backend';

import type { SetupStep } from '#integrations/guest/plan/contracts';
import type {
  GuestAsset,
  ServiceBackend,
  ServiceBackendId,
  ServiceStepContext,
} from '#os/contracts';
import type { ToolSpec } from '#tools/contracts';

/** every backend setup installs to run the guest services, by identifier */
export const SERVICE_BACKENDS: Readonly<
  Record<Exclude<ServiceBackendId, 'provider'>, ServiceBackend>
> = {
  runit: runitBackend,
};

/**
 * lists the tools a provider's service backend needs, so only a guest whose
 * services setup installs a supervisor for gets one
 * @param id the provider's service backend
 * @returns the backend's tools; none when the provider runs the services itself
 */
export function backendTools(id: ServiceBackendId): readonly ToolSpec[] {
  return id === 'provider' ? [] : SERVICE_BACKENDS[id].tools;
}

/**
 * lists the guest libraries the service steps source: cron's, which every
 * backend's jobs step uses, and the backend's own
 * @param id the provider's service backend
 * @returns the libraries setup installs before the service steps run
 */
export function backendAssets(id: ServiceBackendId): readonly GuestAsset[] {
  return id === 'provider'
    ? [CRON_LIBRARY]
    : [SERVICE_BACKENDS[id].library, CRON_LIBRARY];
}

/**
 * builds the steps a backend runs on the guest session: a provider that runs
 * the services itself only gets the jobs step, its services being registered
 * through its own control by `installProviderServices`
 * @param id the provider's service backend
 * @param context the family and the steps that must succeed first
 * @returns the steps that install the backend's services and jobs
 */
export function backendSteps(
  id: ServiceBackendId,
  context: ServiceStepContext,
): SetupStep[] {
  return id === 'provider'
    ? [jobsStep(context)]
    : SERVICE_BACKENDS[id].steps(context);
}
