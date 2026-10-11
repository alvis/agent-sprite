import { render } from 'ink-testing-library';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Select } from '#components/Choices';

describe('rc:Select', () => {
  it('should explain a disabled choice and accepts a search containing spaces', () => {
    const onSubmit = vi.fn();
    const view = render(
      <Select
        choices={[
          {
            label: 'Unavailable choice',
            value: 'blocked',
            disabledReason: 'Authentication is required',
          },
          { label: 'Alpha Beta', value: 'available' },
        ]}
        label="Select a service"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    try {
      expect(view.lastFrame()).toContain(
        'unavailable: Authentication is required',
      );
      act(() => view.stdin.write('\r'));
      expect(view.lastFrame()).toContain(
        'Unavailable: Authentication is required',
      );
      expect(onSubmit).not.toHaveBeenCalled();

      act(() => view.stdin.write('Alpha Beta'));
      expect(view.lastFrame()).toContain('Search: Alpha Beta');
      act(() => view.stdin.write('\r'));
      expect(onSubmit).toHaveBeenCalledWith('available');
    } finally {
      view.unmount();
    }
  });

  it('should keep hidden-choice counts accurate while moving through the viewport', () => {
    const choices = Array.from({ length: 12 }, (_, index) => ({
      label: `Item ${index + 1}`,
      value: `item-${index + 1}`,
    }));
    const view = render(
      <Select
        choices={choices}
        label="Choose an item"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    try {
      expect(view.lastFrame()).toContain('↓ 4 more');
      for (let index = 0; index < 7; index++) {
        act(() => view.stdin.write('\x1b[B'));
      }
      expect(view.lastFrame()).toContain('↑ 2 more');
      expect(view.lastFrame()).toContain('↓ 2 more');
      expect(view.lastFrame()).toContain('› Item 8');
    } finally {
      view.unmount();
    }
  });
});
