import type { IdleForm } from './contracts.js';

// the guest-side contract of a provider's awake adapter: the module a provider
// names in `ProviderDriver.awakeAdapter`, which the idle governor loads from
// the provider's own guest folder and calls according to the provider's
// keep-awake mode. An adapter uses only guest-local mechanisms (REQ-IDLE-11)

/** what the awake adapter of a `native-deadline` provider exports */
export interface AwakeDeadlineAdapter {
  /**
   * hands the governor's awake deadline to the provider's own keep-awake
   * mechanism; the governor calls it after every awake event, whether or not
   * it may initiate sleep, and never longer than its adapter time limit
   * @param deadline the workstation stays awake at least until this instant;
   * a deadline that has passed releases any keep-awake claim, after which the
   * provider's own idle rules apply
   * @throws {Error} when the provider rejects the deadline; the governor records it
   */
  applyAwakeDeadline(deadline: Date): Promise<void>;
}

/** what the awake adapter of a `governed` provider exports */
export interface IdleFormAdapter {
  /**
   * puts the workstation into its first available idle form; the governor
   * calls it from a tick only after the awake deadline and only when sleep is
   * permitted, and calls it again on the next tick after a failure
   * @returns the idle form entered, or why none could be
   */
  enterIdleForm(): Promise<IdleFormOutcome>;
}

/** what one attempt to enter an idle form achieved */
export type IdleFormOutcome =
  | {
      /** the idle form the workstation entered */
      entered: IdleForm;
    }
  | {
      /** non-secret reason no idle form could be entered */
      failure: string;
    }
  | {
      /**
       * non-secret reason the attempt ended without an answer, so the
       * workstation may have entered the idle form and resumed since, and the
       * governor records neither a success nor a failure
       */
      unknown: string;
    };
