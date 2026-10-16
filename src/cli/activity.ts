import { renderToString } from 'ink';

import { progressElement } from '#components/InteractionPresentation';
import { redactResolved } from '#utilities/redaction';

import type { ProgressUpdate } from '#command/contracts';

/** active stage data accepted by the persistent Ink root */
type ProgressActivity = ProgressUpdate & { startedAt: number };

/** ordinary progress presentation settings for one command session */
export interface ActivityOptions {
  quiet?: boolean;
  stagesOwnProgress?: boolean;
}

/** command-lifetime stage stack and its presentation methods */
interface ActivityController {
  current: () => ProgressActivity | undefined;
  publish: (update: ProgressUpdate) => void;
  clear: () => void;
}

/**
 * tracks nested and parallel stage starts without owning terminal input
 * @param params stage presentation settings and output
 * @param params.output diagnostic stream
 * @param params.options suppression and source controls
 * @param params.onChange requests one root rerender
 * @param params.active whether the session still accepts progress
 * @returns active-stage controller with explicit cleanup
 */
export function createActivityController({
  output,
  options,
  onChange,
  active,
}: {
  output: NodeJS.WritableStream;
  options: ActivityOptions;
  onChange: () => void;
  active: () => boolean;
}): ActivityController {
  const activities: ProgressActivity[] = [];

  return {
    current: () => activities[activities.length - 1],
    publish: (update) => {
      if (options.quiet || !active()) {
        return;
      }
      if (update.phase === 'start') {
        activities.push({ ...update, startedAt: Date.now() });
        onChange();

        return;
      }
      if (update.phase === 'complete') {
        const index = activities.findLastIndex(
          (activity) => activity.stage === update.stage,
        );
        if (index >= 0) {
          activities.splice(index, 1);
        }
        onChange();
        writeCompletedStage(output, update);

        return;
      }
      if (!options.stagesOwnProgress) {
        writeCompletedStage(output, update);
      }
    },
    clear: () => {
      activities.length = 0;
      onChange();
    },
  };
}

/**
 * leaves one readable completed line after the spinner is removed
 * @param output diagnostic stream
 * @param update completed or direct-caller progress update
 */
function writeCompletedStage(
  output: NodeJS.WritableStream,
  update: ProgressUpdate,
): void {
  output.write(`${redactResolved(renderToString(progressElement(update)))}\n`);
}
