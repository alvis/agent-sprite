import { cancellationReason } from '#operation';

import { flushOutput } from './streams.js';

import type { InteractionCancellationPort } from './interaction.js';

/** command-owned signal listeners and physical interruption counter */
export interface CommandCancellation extends InteractionCancellationPort {
  dispose(): void;
}

/** final forced outcome and terminal disposal without awaiting workflow recovery */
interface CommandCancellationParams {
  onForce: () => void;
}

const CANCELLED_EXIT_CODE = 130;
const FORCED_FLUSH_TIMEOUT_MS = 100;

/**
 * owns process signals and the terminal's forwarded interrupt events
 * @param params forced-outcome callback owned by the command boundary
 * @returns one command cancellation authority with explicit listener disposal
 */
export function createCommandCancellation(
  params: CommandCancellationParams,
): CommandCancellation {
  const controller = new AbortController();
  let interruptions = 0;
  const cancel = (): void => {
    if (!controller.signal.aborted) {
      process.exitCode = CANCELLED_EXIT_CODE;
      controller.abort(cancellationReason());
    }
  };
  const interrupt = (): void => {
    interruptions += 1;
    if (interruptions === 1) {
      cancel();
    } else if (interruptions === 2) {
      forceExit(params.onForce);
    }
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  return {
    signal: controller.signal,
    cancel,
    interrupt,
    dispose: () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    },
  };
}

/**
 * bounds final output flushing without waiting for unfinished remote work
 * @param onForce emits at most one truthful cancellation result
 */
function forceExit(onForce: () => void): void {
  const exit = (): never => process.exit(CANCELLED_EXIT_CODE);
  setTimeout(exit, FORCED_FLUSH_TIMEOUT_MS);
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    if (process.stderr.isTTY) {
      process.stderr.write('\u001b[?25h');
    }
    onForce();
  } catch {
    exit();
  }
  void flushOutput().then(exit, exit);
}
