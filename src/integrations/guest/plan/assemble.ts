import { catalog } from '#core/catalog';
import { harnessDrivers } from '#core/harnesses';
import { networkDriver } from '#core/networks';
import { selectedChannel } from '#core/release-channels';
import { agentService } from '#core/services';
import { ENVIRONMENT_PATH } from '#integrations/guest/layout';
import { familyOf } from '#os/families';
import { backendSteps, backendTools } from '#services/backends';
import { BASE_TOOLS } from '#tools/base';
import { resolveTools } from '#tools/resolve';

import { idleStep, IDLE_STEP } from '../awake.js';
import { buildEnvironment } from '../environment-build.js';
import {
  environmentNetwork,
  guestJobs,
  guestServices,
} from '../environment-services.js';
import { ENVIRONMENT_MODE, serializeEnvironment } from '../environment.js';

import { BOOTSTRAP_STEP, foundationSteps } from './foundation.js';
import { fileStep } from './steps/file.js';
import { HOMEBREW_STEP } from './steps/homebrew.js';
import { toolSteps } from './steps/tools.js';

import type { WorkstationProfile } from '#core/profile';
import type { ProviderDriver } from '#drivers/contracts';
import type { CommandFault } from '#errors';
import type { OsFamily, OsImage, OsRelease } from '#os/contracts';
import type { Resolution, ToolSpec } from '#tools/contracts';
import type { RefusedSource } from '#tools/resolve';

import type { GuestEnvironment } from '../environment.js';
import type { GuestNetworkIdentity } from '../types.js';

import type { SetupStep } from './contracts.js';
import type { PlanProvider } from './foundation.js';

/** id of the step that writes environment.json */
export const ENVIRONMENT_STEP = 'environment';

/** what a plan is assembled from */
export interface AssemblyParams {
  /** the provider the workstation runs on */
  provider: PlanProvider;
  /** the profile setup applies */
  profile: WorkstationProfile;
  /** the guest's release, as the session probed it */
  release: OsRelease;
  /** sources the guest turned down, such as formulae without a bottle */
  refused?: readonly RefusedSource[];
  /** the running open-agent version */
  version: string;
  /** when setup started, as an ISO 8601 timestamp */
  setupAt: string;
  /** the retained network device identity of an earlier setup */
  networkIdentity?: GuestNetworkIdentity;
}

/** a workstation's assembled setup plan */
export interface SetupAssembly {
  /** the guest's OS family */
  family: OsFamily;
  /** every tool setup resolved */
  tools: readonly ToolSpec[];
  /** the source picked for each tool, or why none is usable */
  resolutions: readonly Resolution[];
  /** the environment the plan writes, its setup still incomplete */
  environment: GuestEnvironment;
  /** steps every package step builds on: guest libraries, boot hook, accounts, bootstrap packages, Homebrew and sysctl */
  foundation: readonly SetupStep[];
  /** the steps after the foundation: tools, idle governor and environment.json */
  steps: readonly SetupStep[];
  /** the services and cron jobs the backend installs and starts, in a plan of their own once the steps succeeded */
  services: readonly SetupStep[];
}

/**
 * lists every tool a workstation installs: the base set, the service
 * backend's, then the agent's, at its release channel's dist-tag, the
 * harnesses' with their ACP adapters, and the network's; a tool two drivers
 * declare is installed once, as the first declares it
 * @param profile the selection
 * @param provider the provider, whose service backend may bring tools
 * @returns the tools, each named once
 */
export function workstationTools(
  profile: WorkstationProfile,
  provider: Pick<PlanProvider, 'serviceBackend'>,
): ToolSpec[] {
  const agent = catalog.agents[profile.agent];
  const channel = selectedChannel(
    agent.releaseChannels,
    profile.options.agentRelease,
  );
  const [cli, ...runtime] = agent.tools;
  const agentTools = cli
    ? [channel ? atDistTag(cli, channel.distTag) : cli, ...runtime]
    : [];
  const harnessTools = harnessDrivers(profile.harnesses).flatMap((driver) => [
    ...driver.tools,
    ...(driver.acpAdapter ? [driver.acpAdapter.tool] : []),
  ]);
  const declared = [
    ...BASE_TOOLS,
    ...backendTools(provider.serviceBackend),
    ...agentTools,
    ...harnessTools,
    ...networkDriver(profile.network).tools,
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
 * @param provider the provider, whose default image is checked
 * @param profile the selection
 * @throws {CommandFault} when a required tool has no usable source on the image
 */
export function assertImageTools(
  provider: Pick<PlanProvider, 'serviceBackend'> &
    Pick<ProviderDriver, 'images'>,
  profile: WorkstationProfile,
): void {
  const release = declaredRelease(provider.images[0]);
  if (release) {
    resolveTools(workstationTools(profile, provider), {
      release,
      family: familyOf(release),
    });
  }
}

/**
 * assembles a workstation's setup plan: the guest libraries and assets, the
 * provider's boot hook before any package step, the agent account, the
 * bootstrap packages, Homebrew and the ping sysctl, then every resolved tool,
 * the idle governor's directories and environment.json; the services and
 * cron jobs the backend installs and starts are a plan of their own, so the
 * caller can configure the workstation before anything starts
 * @param params the provider, profile, probed release and version
 * @returns the steps, the resolved tools and the environment they record
 * @throws {CommandFault} when a required tool has no usable source on the guest
 */
export async function assemblePlan(
  params: AssemblyParams,
): Promise<SetupAssembly> {
  const { provider, profile, release } = params;
  const family = familyOf(release);
  const tools = workstationTools(profile, provider);
  const resolutions = resolveTools(
    tools,
    { release, family },
    params.refused ?? [],
  );
  const environment = assembleEnvironment(params, tools, resolutions);
  const foundation = await foundationSteps({
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
    ],
    // they run once environment.json is written, which the steps include
    services: backendSteps(provider.serviceBackend, { family, needs: [] }),
  };
}

/**
 * builds the environment the plan writes, its setup still incomplete
 * @param params the provider, profile, version and retained identity
 * @param tools every tool setup resolved
 * @param resolutions the source picked for each tool
 * @returns the validated record
 */
function assembleEnvironment(
  params: AssemblyParams,
  tools: readonly ToolSpec[],
  resolutions: readonly Resolution[],
): GuestEnvironment {
  const { provider, profile, release } = params;
  const network = networkDriver(profile.network);
  const agent = agentService(profile);

  return buildEnvironment({
    version: params.version,
    setupAt: params.setupAt,
    state: 'incomplete',
    family: release.family,
    profile,
    provider,
    tools,
    resolutions,
    agent: { id: profile.agent, service: agent },
    harnesses: harnessDrivers(profile.harnesses).map((driver) => ({
      id: driver.id,
      spawnEnvironment: driver.spawnEnvironment,
      ...(driver.acpAdapter && { acpAdapter: driver.acpAdapter }),
    })),
    network: environmentNetwork(network),
    services: guestServices(agent, network.daemon),
    jobs: guestJobs(provider.capabilities),
    ...(params.networkIdentity && { networkIdentity: params.networkIdentity }),
  });
}

/**
 * sets the dist-tag an agent's npm tool installs and updates from
 * @param tool the agent's own CLI
 * @param distTag its release channel's dist-tag
 * @returns the tool, its npm sources at the dist-tag
 */
function atDistTag(tool: ToolSpec, distTag: string): ToolSpec {
  const [first, ...rest] = tool.sources.map((source) =>
    source.kind === 'npm' ? { ...source, distTag } : source,
  );

  return first ? { ...tool, sources: [first, ...rest] } : tool;
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
