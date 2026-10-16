import { useInput } from 'ink';

import type { ReactElement } from 'react';

/** props for the command-lifetime Ink input owner */
type InteractionRootProps = {
  prompt?: ReactElement;
  activity?: ReactElement;
  onInterrupt: () => void;
};

/**
 * keeps Ink's supported input hook active between workflow prompts
 * @param props root presentation and interrupt callback
 * @param props.prompt current prompt, if any
 * @param props.activity current progress display when no prompt is active
 * @param props.onInterrupt receives one callback per physical Ctrl-C event
 * @returns the active prompt or progress display, if any
 */
export function InteractionRoot({
  prompt,
  activity,
  onInterrupt,
}: Readonly<InteractionRootProps>): ReactElement | null {
  useInput((input, key) => {
    if (key.ctrl && input === 'c' && key.eventType !== 'release') {
      onInterrupt();
    }
  });

  return prompt ?? activity ?? null;
}
