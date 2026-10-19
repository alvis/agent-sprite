/** what a provider's boot hook recorded about the guest's last boot */
export interface BootReport {
  /** the last boot's result: `halted` when a critical step stopped it, which setup repairs; absent when no boot has recorded one */
  status?: 'ok' | 'failed' | 'halted';
  /** when the last boot started, as an ISO 8601 timestamp */
  startedAt?: string;
  /** how long the last boot took */
  durationMs?: number;
  /** every step of the last boot that did not succeed, with its outcome */
  unsuccessfulSteps: Readonly<Record<string, string>>;
  /** the boot log's latest step and result lines, oldest first */
  log: readonly string[];
}
