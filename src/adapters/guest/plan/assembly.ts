import { buildEnvironment } from '#adapters/guest/environment/build';
import {
  ENVIRONMENT_MODE,
  serializeEnvironment,
} from '#adapters/guest/environment/contracts';
import {
  environmentNetwork,
  guestJobs,
  guestServices,
} from '#adapters/guest/environment/services';
import { idleStep, IDLE_STEP } from '#adapters/guest/governor';
import { familyOf } from '#adapters/guest/os/families';
import { ENVIRONMENT_PATH } from '#adapters/guest/platform/layout';
import { backendSteps, backendTools } from '#adapters/guest/services/backends';
import { BASE_TOOLS } from '#adapters/guest/tools/base';
import { agentCli } from '#adapters/guest/tools/channel';
import { resolveTools } from '#adapters/guest/tools/resolve';
import { agentService } from '#domain/services';

import { BOOTSTRAP_STEP, foundationSteps } from './foundation';
import { fileStep } from './steps/file';
import { HOMEBREW_STEP } from './steps/homebrew';
import { toolSteps, versionsStep } from './steps/tools';

import type {
  DriverRegistry,
  ProviderDriver,
} from '#application/ports/drivers';
import type {
  AssemblyParams,
  PlanProvider,
  SetupAssembly,
} from '#application/ports/plan';
import type { OsImage, OsRelease } from '#domain/guest';
import type { GuestEnvironment } from '#domain/observations/environment';
import type { WorkstationProfile } from '#domain/profile';
import type { Resolution, ToolSpec } from '#domain/tools';

/** id of the step that writes environment.json */
const ENVIRONMENT_STEP = 'environment';

/**
 * lists every tool a workstation installs: the base set, the service
 * backend's, then the agent's, at its release channel's dist-tag, the
 * harnesses' with their ACP adapters, and the network's; a tool two drivers
 * declare is installed once, as the first declares it
 * @param registry every registered driver
 * @param profile the selection
 * @param provider the provider, whose service backend may bring tools
 * @returns the tools, each named once
 */
function workstationTools(
  registry: DriverRegistry,
  profile: WorkstationProfile,
  provider: Pick<PlanProvider, 'serviceBackend'>,
): ToolSpec[] {
  const agent = registry.agents[profile.agent];
  const cli = agentCli(agent, profile.options.agentRelease);
  const agentTools = cli ? [cli, ...agent.tools.slice(1)] : [];
  const harnessTools = profile.harnesses
    .map((id) => registry.harnesses[id])
    .flatMap((driver) => [
      ...driver.tools,
      ...(driver.acpAdapter ? [driver.acpAdapter.tool] : []),
    ]);
  const declared = [
    ...BASE_TOOLS,
    ...backendTools(provider.serviceBackend),
    ...agentTools,
    ...harnessTools,
    ...registry.networks[profile.network].tools,
  ];
  const named = new Map<string, ToolSpec>();
  for (const tool of declared) {
    if (!named.has(tool.name)) {
      named.set(tool.name, tool);
    }
  }

  return [...named.values()];
}

/**
 * refuses, before the provider creates anything, a selection whose required
 * tools no source serves on the provider's default image; an image whose
 * release only the guest can tell is checked once the guest is probed
 * @param registry every registered driver
 * @param provider the provider, whose default image is checked
 * @param profile the selection
 */
export function assertImageTools(
  registry: DriverRegistry,
  provider: Pick<PlanProvider, 'serviceBackend'> &
    Pick<ProviderDriver, 'images'>,
  profile: WorkstationProfile,
): void {
  const release = declaredRelease(provider.images[0]);
  if (release) {
    resolveTools(workstationTools(registry, profile, provider), {
      release,
      family: familyOf(release),
    });
  }
}

/**
 * assembles a workstation's setup plan: the guest libraries and assets, the
 * provider's boot hook before any package step, the agent account, the
 * bootstrap packages, Homebrew and the ping sysctl, then every resolved tool,
 * the idle governor's directories, environment.json and the version each
 * tool's manager reports installed, recorded into it; the services and
 * cron jobs the backend installs and starts are a plan of their own, so the
 * caller can configure the workstation before anything starts
 * @param registry every registered driver
 * @param params the provider, profile, probed release and version
 * @returns the steps, the resolved tools and the environment they record
 */
export async function assemblePlan(
  registry: DriverRegistry,
  params: AssemblyParams,
): Promise<SetupAssembly> {
  const { provider, profile, release } = params;
  const family = familyOf(release);
  const tools = workstationTools(registry, profile, provider);
  const resolutions = resolveTools(
    tools,
    { release, family },
    params.refused ?? [],
  );
  const environment = assembleEnvironment(registry, params, {
    tools,
    resolutions,
  });
  const foundation = await foundationSteps({
    registry,
    provider,
    profile,
    release,
    family,
    tools,
    resolutions,
  });
  const installed = toolSteps(resolutions, tools, {
    family,
    homebrewStep: HOMEBREW_STEP,
    needs: [BOOTSTRAP_STEP],
  });
  const required = installed
    .filter(({ critical }) => critical)
    .map(({ id }) => id);

  return {
    family,
    tools,
    resolutions,
    environment,
    foundation,
    steps: [
      ...installed,
      idleStep({ needs: required }),
      fileStep(family, {
        id: ENVIRONMENT_STEP,
        component: 'environment',
        path: ENVIRONMENT_PATH,
        contents: serializeEnvironment(environment),
        mode: ENVIRONMENT_MODE,
        needs: [IDLE_STEP, ...required],
      }),
      versionsStep(family, {
        path: ENVIRONMENT_PATH,
        needs: [ENVIRONMENT_STEP],
      }),
    ],
    // they run once environment.json is written, which the steps include
    services: backendSteps(provider.serviceBackend, { family, needs: [] }),
  };
}

/**
 * builds the environment the plan writes, its setup still incomplete
 * @param registry every registered driver
 * @param params the provider, profile, version and retained identity
 * @param resolved the tools setup resolved and the source picked for each
 * @param resolved.tools every tool setup resolved
 * @param resolved.resolutions the source picked for each tool
 * @returns the validated record
 */
function assembleEnvironment(
  registry: DriverRegistry,
  params: AssemblyParams,
  resolved: {
    tools: readonly ToolSpec[];
    resolutions: readonly Resolution[];
  },
): GuestEnvironment {
  const { tools, resolutions } = resolved;
  const { provider, profile, release } = params;
  const network = registry.networks[profile.network];
  const agent = agentService(registry, profile);

  return buildEnvironment(registry, {
    version: params.version,
    setupAt: params.setupAt,
    state: 'incomplete',
    family: release.family,
    profile,
    provider,
    tools,
    resolutions,
    agent: { id: profile.agent, service: agent },
    harnesses: profile.harnesses.map((id) => {
      const driver = registry.harnesses[id];

      return {
        id: driver.id,
        spawnEnvironment: driver.spawnEnvironment,
        ...(driver.acpAdapter && { acpAdapter: driver.acpAdapter }),
      };
    }),
    network: environmentNetwork(network),
    services: guestServices(agent, provider, network.daemon),
    jobs: guestJobs(provider.capabilities),
    ...(params.networkIdentity && { networkIdentity: params.networkIdentity }),
  });
}

/**
 * the release a provider declares for an image, assumed glibc on its first
 * architecture, or nothing when only the guest can tell
 * @param image OS image the provider declares, if any
 * @returns the release resolution checks against
 */
function declaredRelease(image: OsImage | undefined): OsRelease | undefined {
  if (!image?.release) {
    return undefined;
  }

  return {
    family: image.family,
    id: image.release.id,
    versionId: image.release.versionId,
    arch: image.arch[0],
    libc: 'glibc',
  };
}
