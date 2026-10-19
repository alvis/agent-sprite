import { networkDriver } from '#application/catalog/networks';
import { hasActions } from '#application/plugins';
import { harnessIds, harnessLabel } from '#domain/harnesses';
import { pickMachine } from '#domain/machine-sizes';
import { publishStatus } from '#kernel/operation';

import { describePluginSelections } from './plugins';

import type { CommandRequest } from '#application/contracts';
import type { ResolvedInputs } from '#application/input/types';
import type { HarnessPluginActions } from '#application/plugins';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { NetworkExitNode } from '#application/ports/drivers';
import type { Interaction } from '#application/ports/interaction';
import type { WorkstationProfile } from '#domain/profile';

import type { CreatePreflight } from './context';

/** values every create run must have once inputs are resolved */
export interface RequiredCreateValues {
  name: string;
  token: string;
}

/** verified inputs and selections a create run presents for review */
export interface ReviewContext {
  values: RequiredCreateValues;
  input: ResolvedInputs;
  plugins: HarnessPluginActions;
  verifiedExitNode?: NetworkExitNode;
  interaction?: Interaction;
  preflight: CreatePreflight;
}

/** what the creation confirmation names */
interface ConfirmationContext {
  name: string;
  request: CommandRequest;
  plugins: HarnessPluginActions;
  profile: WorkstationProfile;
}

/**
 * presents non-secret values and native code selections for review
 * @param dependencies the registered drivers
 * @param context required create values and optional status reporter
 */
export function reviewCreatePlan(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  context: ReviewContext,
): void {
  const { values, input, plugins, verifiedExitNode, interaction, preflight } =
    context;
  const { profile } = input;
  const provider = dependencies.registry.providers[profile.provider];
  const { credential } = provider.prerequisites;
  publishStatus(
    {
      kind: 'info',
      message: [
        `Create ${values.name} on ${provider.displayName}`,
        machineSummary(dependencies, profile),
        ...releaseSummary(dependencies, profile),
        `Harnesses: ${profile.harnesses.map((id) => harnessLabel(id)).join(', ')}`,
        networkSummary(dependencies, input, verifiedExitNode),
        profile.options.isProxyEnabled
          ? `CLIProxyAPI ${input.proxyUrl}`
          : 'CLIProxyAPI disabled',
        `Suspend after idle: ${idleSummary(profile.options.idleTimeoutMinutes)}`,
        `${dependencies.registry.agents[profile.agent].displayName} exposed after readiness`,
        `${credential.label}: ${input.sources[credential.environment] ?? 'prompt/session'}`,
        ...networkCredentialLines(dependencies, input),
        `GitHub: ${input.githubToken ? 'selected' : 'skipped'}; Git identity: ${input.gitIdentity ? 'configured' : 'skipped'}`,
        ...describePluginSelections(plugins, profile.harnesses),
      ].join('\n'),
    },
    interaction,
  );
  for (const message of preflight.reminders) {
    publishStatus({ kind: 'warning', message }, interaction);
  }
}

/**
 * confirms selected native code and provider provisioning separately
 * @param dependencies the registered drivers
 * @param context exact name, parsed consent flags, and selected code
 * @param interaction optional confirmation prompts
 * @returns cancellation reason when a confirmation was declined
 */
export async function confirmCreation(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  context: ConfirmationContext,
  interaction?: Interaction,
): Promise<string | undefined> {
  const { name, request, plugins, profile } = context;
  if (
    interaction &&
    !request.options.yes &&
    harnessIds().some((id) => hasActions(plugins[id]))
  ) {
    const trusted = await interaction.confirm({
      message:
        'Install the selected native marketplace/plugin code, including executable hooks?',
    });
    if (!trusted) {
      return 'Plugin selection was not accepted; no workstation was created';
    }
  }
  if (interaction && !request.options.nonInteractive && !request.options.yes) {
    const accepted = await interaction.confirm({
      message: `Create ${name} on ${dependencies.registry.providers[profile.provider].displayName} and expose authenticated ${dependencies.registry.agents[profile.agent].displayName} at its provider URL?`,
    });
    if (!accepted) {
      return 'Create was cancelled before provisioning';
    }
  }

  return undefined;
}

/**
 * names the machine the provider picks for the minimums
 * @param dependencies the registered drivers
 * @param profile validated selection
 * @returns one review line naming the minimums and, when the provider names it, the machine
 */
function machineSummary(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  profile: WorkstationProfile,
): string {
  const { minCpus, minMemoryGb } = profile.options;
  const offer = pickMachine(
    dependencies.registry.providers[profile.provider].machines,
    {
      cpus: minCpus,
      memoryGb: minMemoryGb,
    },
  );

  const picked = offer
    ? ` (${offer.label}, ${String(offer.cpus)} CPUs, ${String(offer.memoryGb)} GB)`
    : '';

  return `Machine: at least ${String(minCpus)} CPUs, ${String(minMemoryGb)} GB${picked}`;
}

/**
 * names the release channel the agent follows
 * @param dependencies the registered drivers
 * @param profile validated selection
 * @returns one review line, none when the agent declares no channels
 */
function releaseSummary(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  profile: WorkstationProfile,
): string[] {
  const { agentRelease } = profile.options;

  return agentRelease === undefined
    ? []
    : [
        `${dependencies.registry.agents[profile.agent].displayName} release: ${agentRelease}`,
      ];
}

/**
 * summarizes the selected network and its routing for the creation review
 * @param dependencies the registered drivers
 * @param input resolved selection and exit node selector
 * @param verifiedExitNode exit node the network verified, when it could
 * @returns one review line
 */
function networkSummary(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  input: ResolvedInputs,
  verifiedExitNode?: NetworkExitNode,
): string {
  const network = networkDriver(dependencies.registry, input.profile.network);
  if (!network.daemon) {
    return 'No private network';
  }

  return input.profile.options.isExitNodeEnabled
    ? `${network.displayName} enabled, exit node ${verifiedExitNode?.name ?? input.exitNode}`
    : `${network.displayName} enabled, direct routing`;
}

/**
 * describes the idle suspension the profile records
 * @param minutes minutes before suspension, 0 for never
 * @returns review text
 */
function idleSummary(minutes: number): string {
  return minutes ? `${minutes} minutes` : 'never';
}

/**
 * names where the selected network's management credential comes from
 * @param dependencies the registered drivers
 * @param input resolved inputs and their sources
 * @returns one review line, or none without a selected network
 */
function networkCredentialLines(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  input: ResolvedInputs,
): string[] {
  const network = networkDriver(dependencies.registry, input.profile.network);
  if (!network.inputs) {
    return [];
  }
  const source =
    input.sources[network.inputs.management.environment] ??
    (input.enrollmentKey ? 'auth key' : 'prompt/session');

  return [`${network.displayName} credential: ${source}`];
}
