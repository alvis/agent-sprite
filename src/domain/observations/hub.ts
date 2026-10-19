/** non-billable current gateway reachability result */
export interface HubStatus {
  /** whether the gateway answered its model catalogue request */
  reachable: boolean;
  /** whether the check was skipped because the gateway is not selected */
  skipped: boolean;
  /** HTTP status the gateway answered with */
  status?: number;
  /** bounded reason the gateway could not be reached */
  reason?: string;
}
