import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { InteractionRoot } from '#cli/components/InteractionRoot';

describe('rc:InteractionRoot', () => {
  it('should give an active prompt precedence over progress and keeps interrupt input owned', () => {
    const onInterrupt = vi.fn();
    const activity = <Text>create stage is running</Text>;
    const view = render(
      <InteractionRoot
        activity={activity}
        prompt={<Text>Choose an action</Text>}
        onInterrupt={onInterrupt}
      />,
    );
    try {
      expect(view.lastFrame()).toContain('Choose an action');
      expect(view.lastFrame()).not.toContain('create stage is running');

      view.rerender(
        <InteractionRoot activity={activity} onInterrupt={onInterrupt} />,
      );
      expect(view.lastFrame()).toContain('create stage is running');
      view.stdin.write('\x03');
      expect(onInterrupt).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });
});
