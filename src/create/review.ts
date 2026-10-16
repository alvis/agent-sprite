import { catalog } from '#core/catalog';
import { harnessIds, harnessLabel } from '#core/harnesses';
import { networkDriver } from '#core/networks';
import { pickMachine } from '#drivers/machine-sizes';
import { publishStatus } from '#operation';
import { hasActions } from '#plugins';

import { describePluginSelections } from './plugins';

import type { CommandRequest, Interaction } from '#command/contracts';
import type { WorkstationProfile } from '#core/profile';
import type { NetworkExitNode } from '#drivers/networks/contracts';
import type { ResolvedInputs } from '#input/types';
import type { HarnessPluginActions } from '#plugins';

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
 * @param context required create values and optional status reporter
 */
export function reviewCreatePlan(context: ReviewContext): void {
  const { values, input, plugins, verifiedExitNode, interaction, preflight } =
    context;
  const { profile } = input;
  const provider = catalog.providers[profile.provider];
  const { credential } = provider.prerequisites;
  publishStatus(
    {
      kind: 'info',
      message: [
        `Create ${values.name} on ${provider.displayName}`,
        machineSummary(profile),
        ...releaseSummary(profile),
        `Harnesses: ${profile.harnesses.map((id) => harnessLabel(id)).join(', ')}`,
        networkSummary(input, verifiedExitNode),
        profile.options.isProxyEnabled
          ? `CLIProxyAPI ${input.proxyUrl}`
          : 'CLIProxyAPI disabled',
        `Suspend after idle: ${idleSummary(profile.options.idleTimeoutMinutes)}`,
        `${catalog.agents[profile.agent].displayName} exposed after readiness`,
        `${credential.label}: ${input.sources[credential.environment] ?? 'prompt/session'}`,
        ...networkCredentialLines(input),
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
 * @param context exact name, parsed consent flags, and selected code
 * @param interaction optional confirmation prompts
 * @returns cancellation reason when a confirmation was declined
 */
export async function confirmCreation(
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
      message: `Create ${name} on ${catalog.providers[profile.provider].displayName} and expose authenticated ${catalog.agents[profile.agent].displayName} at its provider URL?`,
    });
    if (!accepted) {
      return 'Create was cancelled before provisioning';
    }
  }

  return undefined;
}

/**
 * names the machine the provider picks for the minimums
 * @param profile validated selection
 * @returns one review line naming the minimums and, when the provider names it, the machine
 */
function machineSummary(profile: WorkstationProfile): string {
  const { minCpus, minMemoryGb } = profile.options;
  const offer = pickMachine(catalog.providers[profile.provider].machines, {
    cpus: minCpus,
    memoryGb: minMemoryGb,
  });

  const picked = offer
    ? ` (${offer.label}, ${String(offer.cpus)} CPUs, ${String(offer.memoryGb)} GB)`
    : '';

  return `Machine: at least ${String(minCpus)} CPUs, ${String(minMemoryGb)} GB${picked}`;
}

/**
 * names the release channel the agent follows
 * @param profile validated selection
 * @returns one review line, none when the agent declares no channels
 */
function releaseSummary(profile: WorkstationProfile): string[] {
  const { agentRelease } = profile.options;

  return agentRelease === undefined
    ? []
    : [`${catalog.agents[profile.agent].displayName} release: ${agentRelease}`];
}

/**
 * summarizes the selected network and its routing for the creation review
 * @param input resolved selection and exit node selector
 * @param verifiedExitNode exit node the network verified, when it could
 * @returns one review line
 */
function networkSummary(
  input: ResolvedInputs,
  verifiedExitNode?: NetworkExitNode,
): string {
  const network = networkDriver(input.profile.network);
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
 * @param input resolved inputs and their sources
 * @returns one review line, or none without a selected network
 */
function networkCredentialLines(input: ResolvedInputs): string[] {
  const network = networkDriver(input.profile.network);
  if (!network.inputs) {
    return [];
  }
  const source =
    input.sources[network.inputs.management.environment] ??
    (input.enrollmentKey ? 'auth key' : 'prompt/session');

  return [`${network.displayName} credential: ${source}`];
}
