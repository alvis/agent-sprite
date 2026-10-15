/** provider state observed after a failed create request */
export type CreationOutcome = 'retained' | 'absent' | 'unknown';

/** reconciled provider observation and the original create failure */
export interface WorkstationCreationFaultParams extends ErrorOptions {
  /** user-facing description of the reconciled outcome */
  message: string;
  /** requested or observed workstation name */
  machine: string;
  /** immutable provider identity, when one was observed */
  machineId?: string;
  /** reconciled provider state */
  outcome: CreationOutcome;
}

/** a create failure reconciled against the live provider name */
export class WorkstationCreationFault extends Error {
  public readonly machine: string;
  public readonly machineId?: string;
  public readonly setupIncomplete?: true;
  public readonly outcome: CreationOutcome;

  /**
   * records the observed provider state after a failed create request
   * @param params reconciled outcome, identity and original failure
   */
  constructor(params: WorkstationCreationFaultParams) {
    super(params.message, { cause: params.cause });
    this.name = 'WorkstationCreationFault';
    this.machine = params.machine;
    this.machineId = params.machineId;
    this.setupIncomplete = params.outcome === 'retained' ? true : undefined;
    this.outcome = params.outcome;
  }
}
