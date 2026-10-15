import { ProviderFault } from '#drivers/failures';

/**
 * a session whose transport broke: the shell, its connection or its framing
 * failed, so a command's outcome is unknown. It is transient, and only it is
 * retried, by rerunning the step from its check in a new session
 */
export class SessionTransportFault extends ProviderFault {
  /**
   * records why the session can no longer be trusted
   * @param message what broke
   * @param options the underlying failure
   */
  constructor(message: string, options?: ErrorOptions) {
    super({ code: 'transient', message, cause: options?.cause });
    this.name = 'SessionTransportFault';
  }
}

/**
 * tells whether a failure is a transport fault, which a step may retry
 * @param error the failure
 * @returns true when the session or the connection to the guest broke
 */
export function isTransportFault(error: unknown): boolean {
  return error instanceof ProviderFault && error.code === 'transient';
}
