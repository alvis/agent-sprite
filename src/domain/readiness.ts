/** outcome of one readiness check */
export type ReadinessStatus = 'passed' | 'failed' | 'skipped';

/** one named readiness observation */
export interface ReadinessFinding {
  /** human-readable check name */
  name: string;
  /** check outcome */
  status: ReadinessStatus;
}
