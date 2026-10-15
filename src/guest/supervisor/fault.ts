import type { ControlFailureCode } from './protocol.js';

// guest kernel: imports only Node built-ins and other guest code. A refusal
// carries the control code the client answers with

/** a request the supervisor refuses or cannot carry out */
export class SupervisorFault extends Error {
  /** the control failure the request is answered with */
  public readonly code: ControlFailureCode;

  /**
   * names the failure
   * @param code why the request failed
   * @param message non-secret reason
   */
  constructor(code: ControlFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}
