import type { AgentId, HarnessId } from '#domain/ids';
import type { AgentEnvironments } from '#domain/observations/agent';
import type { NativeHarnessInspection } from '#domain/observations/harness';

/** what open-agent manages and observes natively for one selected harness */
export interface HarnessAgentState {
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
  agentEnvironment?: AgentEnvironments[AgentId];
  /** the managed plugins and evidence of each selected harness, keyed by harness identifier */
  harnesses: Partial<Record<HarnessId, HarnessAgentState>>;
}
