/** user-facing status emitted by an operation */
export interface StatusUpdate {
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

/** receives user-facing status from an operation */
export interface StatusSink {
  status(update: StatusUpdate): void;
}
