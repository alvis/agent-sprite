import { catalog, DEFAULT_SELECTION } from '#core/catalog';
import { harnessDrivers, inspectHarnesses } from '#core/harnesses';
import { runOperation } from '#operation';

import type {
  AgentId,
  HarnessId,
  RegisteredAgentEnvironment,
} from '#core/catalog';
import type { NativeHarnessInspection } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

/** what open-agent manages and observes natively for one selected harness */
interface HarnessAgentState {
  /** plugin identities open-agent manages natively */
  selectedPlugins: string[];
  /** probe evidence the harness reported natively */
  evidence: unknown;
}

/** current non-secret native configuration state for explicit inspection */
export interface NativeConfigurationInspection extends Partial<
  Record<HarnessId, NativeHarnessInspection>
> {
  /** what the running agent service reports at its environment endpoint */
  agentEnvironment?: RegisteredAgentEnvironment;
  /** the managed plugins and evidence of each selected harness, keyed by harness identifier */
  harnesses: Partial<Record<HarnessId, HarnessAgentState>>;
}

/**
 * reads native user settings and validates native plugin-list commands without a model turn
 * @param guest target guest
 * @param selection selected agent and harness identifiers to inspect
 * @param selection.agent selected ACP agent
 * @param selection.harnesses selected harnesses
 * @returns current non-secret native settings and loading evidence
 */
export async function inspectNativeConfiguration(
  guest: GuestChannel,
  selection?: { agent: AgentId; harnesses: readonly HarnessId[] },
): Promise<NativeConfigurationInspection> {
  const drivers = harnessDrivers(selection?.harnesses);
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
        inspections[driver.id]?.configuration,
      ]),
    ),
    agentEnvironment: environment,
    harnesses: Object.fromEntries(
      drivers.flatMap(({ id }) => {
        const inspection = inspections[id];
        const state: HarnessAgentState = {
          selectedPlugins: inspection?.selectedPlugins ?? [],
          evidence: inspection?.evidence,
        };

        return inspection ? [[id, state] as const] : [];
      }),
    ),
  };
}

/**
 * asks the selected agent's own environment check, one guest round trip and no other probe
 * @param guest target guest
 * @param agent selected ACP agent, else the default
 * @returns what the running agent service reports, absent when it could not be probed
 */
export async function inspectAgentEnvironment(
  guest: GuestChannel,
  agent: AgentId = DEFAULT_SELECTION.agent,
): Promise<RegisteredAgentEnvironment | undefined> {
  return catalog.agents[agent].inspectEnvironment(guest);
}
