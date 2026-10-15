import { catalog, DEFAULT_SELECTION } from '#core/catalog';
import { harnessIds } from '#core/harnesses';
import { agentIds, providerIds } from '#core/ids';
import { networksWithInputs, networkDriver, networkIds } from '#core/networks';
import { isDriverId } from '#core/profile';
import { CLIPROXYAPI_INPUTS } from '#drivers/shared/cliproxyapi/inputs';

import { hasValue } from './selection-sources.js';

import type { CommandOptions, InteractionChoice } from '#command/contracts';
import type { AgentId, HarnessId, NetworkId, ProviderId } from '#core/catalog';
import type { ReleaseChannels } from '#drivers/contracts';

import type { InputSources } from './sources.js';

/**
 * offers every registered provider
 * @returns one labelled choice per provider
 */
export function providerChoices(): Array<InteractionChoice<ProviderId>> {
  return providerIds().map((id) => ({
    label: catalog.providers[id].displayName,
    value: id,
  }));
}

/**
 * offers every registered ACP agent
 * @returns one labelled choice per ACP agent
 */
export function agentChoices(): Array<InteractionChoice<AgentId>> {
  return agentIds().map((id) => ({
    label: catalog.agents[id].displayName,
    value: id,
  }));
}

/**
 * offers the harnesses the selected ACP agent supports
 * @param agent selected agent id
 * @param preselected harnesses that start selected; the defaults when omitted
 * @returns one labelled choice per supported harness, preselected where chosen
 */
export function harnessChoices(
  agent: string,
  preselected: readonly HarnessId[] = defaultHarnesses(agent),
): Array<InteractionChoice<HarnessId>> {
  return supportedHarnesses(agent).map((id) => ({
    label: catalog.harnesses[id].displayName,
    value: id,
    isPreselected: preselected.includes(id),
  }));
}

/**
 * offers every registered network with the default first
 * @param preferred network to offer first
 * @returns one labelled choice per network, the preferred one first
 */
export function networkChoices(
  preferred: NetworkId = DEFAULT_SELECTION.network,
): Array<InteractionChoice<NetworkId>> {
  return [preferred, ...networkIds().filter((id) => id !== preferred)].map(
    (id) => ({ label: catalog.networks[id].displayName, value: id }),
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
 * @param agent agent id, possibly unregistered
 * @returns supported harness ids; every harness when the agent is unknown
 */
function supportedHarnesses(agent: string): HarnessId[] {
  return isDriverId('agents', agent)
    ? harnessIds().filter((id) =>
        catalog.agents[agent].supportedHarnesses.includes(id),
      )
    : harnessIds();
}

/**
 * selects the default harnesses the agent supports
 * @param agent agent id
 * @returns default harnesses, or every supported harness when none of the defaults is
 */
export function defaultHarnesses(agent: string): HarnessId[] {
  const supported = supportedHarnesses(agent);
  const defaults = DEFAULT_SELECTION.harnesses.filter((id) =>
    supported.includes(id),
  );

  return defaults.length > 0 ? defaults : supported;
}

/**
 * picks the first network whose declared inputs the caller supplied
 * @param options parsed flags
 * @param sources process, env file and profile values
 * @returns the network those inputs select, if any
 */
export function inferNetwork(
  options: CommandOptions,
  sources: InputSources,
): NetworkId | undefined {
  const hasFlags = [
    options.networkAccount,
    options.networkKeySource,
    options.networkAuthKeySource,
    options.exitNode,
  ].some((value) => Boolean(value?.trim()));

  return networksWithInputs().find(
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

/**
 * infers options from supplied inputs, as non-interactive runs always have
 * @param options parsed flags
 * @param sources process, env file and profile values
 * @param network network the supplied inputs select, from {@link inferNetwork}
 * @returns options the supplied inputs imply
 */
export function inferredOptions(
  options: CommandOptions,
  sources: InputSources,
  network: NetworkId | undefined,
): { isExitNodeEnabled: boolean; isProxyEnabled: boolean } {
  const exitNode = network
    ? networkDriver(network).inputs?.exitNode.environment
    : undefined;

  return {
    isExitNodeEnabled:
      Boolean(options.exitNode?.trim()) ||
      (exitNode !== undefined && hasValue(sources, exitNode)),
    isProxyEnabled:
      [options.proxyUrl, options.proxyApiKeySource].some((value) =>
        Boolean(value?.trim()),
      ) ||
      [CLIPROXYAPI_INPUTS.baseUrl, CLIPROXYAPI_INPUTS.apiKey].some(
        ({ environment }) => hasValue(sources, environment),
      ),
  };
}
