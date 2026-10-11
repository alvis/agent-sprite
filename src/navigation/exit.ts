/** user-requested navigation, distinct from an operation failure */
export class InteractionExit extends Error {
  public readonly action: 'back' | 'cancel';

  /**
   * identifies a navigation request without an operational error message
   * @param action requested navigation direction
   */
  constructor(action: 'back' | 'cancel') {
    super(action === 'back' ? 'Back requested.' : 'Cancelled by user.');
    this.action = action;
  }
}
