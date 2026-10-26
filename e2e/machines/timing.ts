/** milliseconds in one second */
export const SECOND_MS = 1_000;

/**
 * waits without blocking the event loop
 * @param ms milliseconds to wait; nonpositive values return immediately
 */
export async function sleep(ms: number): Promise<void> {
  if (ms > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
