import { runOperation } from '#kernel/operation';

import type { DriverRegistry } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { AgentId, HarnessId } from '#domain/ids';
import type { AgentEnvironments } from '#domain/observations/agent';
import type {
  HarnessAgentState,
  NativeConfigurationInspection,
} from '#domain/observations/native';
import type { ProfileDefaults } from '#domain/profile';

/** the native inspection's two reads */
export interface NativeInspection {
  /**
   * reads native user settings and validates native plugin-list commands without a model turn
   * @param guest target guest
   * @param selection selected agent and harness identifiers to inspect
   * @param selection.agent selected ACP agent
   * @param selection.harnesses selected harnesses
   * @returns current non-secret native settings and loading evidence
   */
  inspect(
    guest: GuestChannel,
    selection?: { agent: AgentId; harnesses: readonly HarnessId[] },
  ): Promise<NativeConfigurationInspection>;
  /**
   * asks the selected agent's own environment check, one guest round trip and no other probe
   * @param guest target guest
   * @param agent selected ACP agent, else the default
   * @returns what the running agent service reports, absent when it could not be probed
   */
  inspectAgentEnvironment(
    guest: GuestChannel,
    agent?: AgentId,
  ): Promise<AgentEnvironments[AgentId] | undefined>;
}

/**
 * builds the native inspection over the registered drivers
 * @param context the registered drivers and the selection that stands when none is given
 * @param context.registry every registered driver
 * @param context.defaults the default selection
 * @returns the inspection reads
 */
export function createNativeInspection(context: {
  registry: DriverRegistry;
  defaults: ProfileDefaults;
}): NativeInspection {
  const { registry, defaults } = context;
  const inspectAgentEnvironment = async (
    guest: GuestChannel,
    agent: AgentId = defaults.selection.agent,
  ): Promise<AgentEnvironments[AgentId] | undefined> =>
    registry.agents[agent].inspectEnvironment(guest);

  return {
    inspectAgentEnvironment,
    inspect: async (guest, selection) => {
      const drivers = (
        selection?.harnesses ?? defaults.selection.harnesses
      ).map((id) => registry.harnesses[id]);
      const [inspections, environment] = await runOperation(async () =>
        Promise.all([
          inspectHarnesses(guest, drivers),
          inspectAgentEnvironment(guest, selection?.agent),
        ] as const),
      );

      return {
        ...Object.fromEntries(
          drivers.map((driver) => [
            driver.id,
            inspections[driver.id]!.configuration,
          ]),
        ),
        agentEnvironment: environment,
        harnesses: Object.fromEntries(
          drivers.map(({ id }) => {
            const inspection = inspections[id]!;
            const state: HarnessAgentState = {
              selectedPlugins: inspection.selectedPlugins,
              evidence: inspection.evidence,
            };

            return [id, state] as const;
          }),
        ),
      };
    },
  };
}

/** every registered harness driver */
type AnyHarnessDriver = DriverRegistry['harnesses'][HarnessId];

/** what each selected harness driver observed, keyed by harness identifier */
type HarnessInspections = {
  [Id in HarnessId]?: Awaited<
    ReturnType<DriverRegistry['harnesses'][Id]['inspect']>
  >;
};

/**
 * observes the native state of every given harness concurrently
 * @param guest guest channel
 * @param drivers selected harness drivers
 * @returns each harness's inspection, keyed by harness identifier
 */
async function inspectHarnesses(
  guest: GuestChannel,
  drivers: readonly AnyHarnessDriver[],
): Promise<HarnessInspections> {
  const entries = await Promise.all(
    drivers.map(
      async (driver) => [driver.id, await driver.inspect(guest)] as const,
    ),
  );

  return Object.fromEntries(entries);
}
