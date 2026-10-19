/** what the running T3 service reports at its unauthenticated environment endpoint */
export type T3Environment =
  | {
      ok: true;
      /** version the running T3 server reports */
      serverVersion: string;
      /** environment label the server reports, which is the workstation name once the guest names itself after it */
      label?: string;
      /** orchestration protocol revision the server reports, when it does */
      orchestrationProtocolVersion?: number;
    }
  | {
      ok: false;
      /** bounded reason the endpoint did not answer as expected */
      reason: string;
    };

/** what each registered ACP agent reports about its running service, keyed by agent */
export interface AgentEnvironments {
  t3: T3Environment;
}
