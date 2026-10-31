import { render } from 'ink-testing-library';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmInput, Select } from '#cli/components/Choices';

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

  it('should recover from an empty search and keep cancellation separate from selection', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <Select
        choices={[
          { label: 'Alpha', value: 'alpha', description: 'First service' },
          { label: 'Beta', value: 'beta' },
        ]}
        label="Choose service"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );
    try {
      act(() => view.stdin.write('zz'));
      act(() => view.stdin.write('\r'));
      expect(view.lastFrame()).toContain('No matching choices');
      expect(onSubmit.mock.calls).toEqual([]);

      act(() => view.stdin.write('\x08'));
      act(() => view.stdin.write('\x7f'));
      expect(view.lastFrame()).toContain('› Alpha');
      act(() => view.stdin.write('\x1b[B'));
      act(() => view.stdin.write('\x1b[A'));
      act(() => view.stdin.write('\x1b[A'));
      expect(view.lastFrame()).toContain('› Alpha');
      act(() => view.stdin.write('\x03'));
      act(() => view.stdin.write('\x04'));
      act(() => view.stdin.write('\x1ba'));
      expect(onCancel.mock.calls).toEqual([]);
      expect(view.lastFrame()).toContain('› Alpha');
      act(() => view.stdin.write('\r'));
      expect(onSubmit.mock.calls).toEqual([['alpha']]);
      act(() => view.stdin.write('\x1b'));
      await vi.waitFor(() => expect(onCancel.mock.calls).toEqual([[true]]));
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

describe('rc:ConfirmInput', () => {
  it.each([false, true])(
    'should apply the displayed default and preserve explicit refusal and back navigation (%s)',
    async (defaultAnswer) => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const view = render(
        <ConfirmInput
          backLabel="setup"
          defaultAnswer={defaultAnswer}
          description="The workstation will briefly stop"
          label="Restart?"
          onCancel={onCancel}
          onSubmit={onSubmit}
        />,
      );
      try {
        expect(view.lastFrame()).toContain(defaultAnswer ? '[Y/n]' : '[y/N]');
        act(() => view.stdin.write('x'));
        act(() => view.stdin.write('\x03'));
        expect(onSubmit.mock.calls).toEqual([]);
        expect(onCancel.mock.calls).toEqual([]);
        act(() => view.stdin.write('\r'));
        act(() => view.stdin.write('N'));
        expect(onSubmit.mock.calls).toEqual([[defaultAnswer], [false]]);
        act(() => view.stdin.write('\x1b'));
        await vi.waitFor(() => expect(onCancel.mock.calls).toEqual([[true]]));
      } finally {
        view.unmount();
      }
    },
  );
});
