import {
  networksWithInputs,
  networkDriver,
} from '#application/catalog/networks';
import { harnessIds } from '#domain/harnesses';
import { AGENT_IDS, PROVIDER_IDS } from '#domain/ids';
import { isNetworkId, networkIds } from '#domain/networks';
import { isDriverId } from '#domain/profile-rules';

import { hasValue } from './selection-sources';

import type { CommandOptions } from '#application/contracts';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { InteractionChoice } from '#application/ports/interaction';
import type { ReleaseChannels } from '#domain/declarations';
import type { AgentId, HarnessId, NetworkId, ProviderId } from '#domain/ids';

import type { InputSources } from './sources';

/**
 * offers every registered provider
 * @param dependencies the registered drivers
 * @returns one labelled choice per provider
 */
export function providerChoices(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
): Array<InteractionChoice<ProviderId>> {
  return PROVIDER_IDS.map((id) => ({
    label: dependencies.registry.providers[id].displayName,
    value: id,
  }));
}

/**
 * offers every registered ACP agent
 * @param dependencies the registered drivers
 * @returns one labelled choice per ACP agent
 */
export function agentChoices(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
): Array<InteractionChoice<AgentId>> {
  return AGENT_IDS.map((id) => ({
    label: dependencies.registry.agents[id].displayName,
    value: id,
  }));
}

/**
 * offers the harnesses the selected ACP agent supports
 * @param dependencies the registered drivers, the profile defaults
 * @param agent selected agent id
 * @param preselected harnesses that start selected; the defaults when omitted
 * @returns one labelled choice per supported harness, preselected where chosen
 */
export function harnessChoices(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults'>,
  agent: string,
  preselected: readonly HarnessId[] = defaultHarnesses(dependencies, agent),
): Array<InteractionChoice<HarnessId>> {
  return supportedHarnesses(dependencies, agent).map((id) => ({
    label: dependencies.registry.harnesses[id].displayName,
    value: id,
    isPreselected: preselected.includes(id),
  }));
}

/**
 * offers every registered network with the default first
 * @param dependencies the registered drivers, the profile defaults
 * @param preferred network to offer first
 * @returns one labelled choice per network, the preferred one first
 */
export function networkChoices(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults'>,
  preferred: NetworkId = dependencies.defaults.selection.network,
): Array<InteractionChoice<NetworkId>> {
  return [preferred, ...networkIds().filter((id) => id !== preferred)].map(
    (id) => ({
      label: dependencies.registry.networks[id].displayName,
      value: id,
    }),
  );
}

/**
 * offers the release channels an agent declares with the preferred one first
 * @param channels the agent's declared channels
 * @param preferred channel to offer first
 * @returns one labelled choice per channel, the preferred one first
 */
export function releaseChoices(
  channels: ReleaseChannels,
  preferred: string,
): Array<InteractionChoice<string>> {
  return [
    ...channels.channels.filter(({ id }) => id === preferred),
    ...channels.channels.filter(({ id }) => id !== preferred),
  ].map(({ id }) => ({ label: id, value: id }));
}

/**
 * lists the harnesses an agent supports
 * @param dependencies the registered drivers
 * @param agent agent id, possibly unregistered
 * @returns supported harness ids; every harness when the agent is unknown
 */
function supportedHarnesses(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  agent: string,
): HarnessId[] {
  return isDriverId(dependencies.registry, 'agents', agent)
    ? harnessIds().filter((id) =>
        dependencies.registry.agents[agent].supportedHarnesses.includes(id),
      )
    : harnessIds();
}

/**
 * selects the default harnesses the agent supports
 * @param dependencies the registered drivers, the profile defaults
 * @param agent agent id
 * @returns default harnesses, or every supported harness when none of the defaults is
 */
export function defaultHarnesses(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults'>,
  agent: string,
): HarnessId[] {
  const supported = supportedHarnesses(dependencies, agent);
  const preselected = dependencies.defaults.selection.harnesses.filter((id) =>
    supported.includes(id),
  );

  return preselected.length > 0 ? preselected : supported;
}

/**
 * picks the first network whose declared inputs the caller supplied
 * @param dependencies the registered drivers
 * @param options parsed flags
 * @param sources process, credential file and profile values
 * @returns the network those inputs select, if any
 */
export function inferNetwork(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  options: CommandOptions,
  sources: InputSources,
): NetworkId | undefined {
  const hasFlags = [
    options.networkAccount,
    options.networkKeySource,
    options.networkAuthKeySource,
    options.exitNode,
  ].some((value) => Boolean(value?.trim()));

  return networksWithInputs(dependencies.registry).find(
    ({ inputs }) =>
      hasFlags ||
      [
        inputs.account,
        inputs.management,
        inputs.enrollment,
        inputs.exitNode,
      ].some(({ environment }) => hasValue(sources, environment)),
  )?.id;
}

/** the named inputs of inferred options */
export interface InferredOptionsParams {
  /** parsed flags */
  options: CommandOptions;
  /** process, credential file and profile values */
  sources: InputSources;
  /** network the options select; ignored unless it names a registered network */
  network: string | undefined;
}

/**
 * infers options from supplied inputs, as non-interactive runs always have
 * @param dependencies the registered drivers
 * @param params the call's inputs: options, sources, network
 * @returns options the supplied inputs imply
 */
export function inferredOptions(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  params: InferredOptionsParams,
): { isExitNodeEnabled: boolean; isProxyEnabled: boolean } {
  const { options, sources, network } = params;
  const exitNode =
    network !== undefined && isNetworkId(network)
      ? networkDriver(dependencies.registry, network).inputs?.exitNode
          .environment
      : undefined;

  return {
    isExitNodeEnabled:
      Boolean(options.exitNode?.trim()) ||
      (exitNode !== undefined && hasValue(sources, exitNode)),
    isProxyEnabled:
      [options.proxyUrl, options.proxyApiKeySource].some((value) =>
        Boolean(value?.trim()),
      ) ||
      [
        dependencies.registry.gateways.cliproxyapi.inputs.baseUrl,
        dependencies.registry.gateways.cliproxyapi.inputs.apiKey,
      ].some(({ environment }) => hasValue(sources, environment)),
  };
}
