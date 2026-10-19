import { render } from 'ink-testing-library';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MultiSelect } from '#cli/components/MultiSelect';

describe('rc:MultiSelect', () => {
  it('should accept, declines or backs out of an empty-selection confirmation', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <MultiSelect
        choices={[{ label: 'Alpha', value: 'alpha' }]}
        label="Choose plugins"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );
    try {
      act(() => view.stdin.write('\r'));
      expect(view.lastFrame()).toContain('Continue with no choices selected?');
      expect(onSubmit).not.toHaveBeenCalled();

      act(() => view.stdin.write('n'));
      expect(view.lastFrame()).toContain('Choose plugins');
      act(() => view.stdin.write('\r'));
      act(() => view.stdin.write('\r'));
      expect(view.lastFrame()).toContain('Choose plugins');
      act(() => view.stdin.write('\r'));
      act(() => view.stdin.write('\x1b'));
      await vi.waitFor(() =>
        expect(view.lastFrame()).toContain('Choose plugins'),
      );
      expect(onCancel).not.toHaveBeenCalled();

      act(() => view.stdin.write('\r'));
      act(() => view.stdin.write('y'));
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onSubmit).toHaveBeenCalledWith([]);
    } finally {
      view.unmount();
    }
  });

  it('should search names with spaces while Tab toggles the filtered choice', () => {
    const onSubmit = vi.fn();
    const view = render(
      <MultiSelect
        choices={[
          { label: 'Alpha Beta', value: 'alpha' },
          { label: 'Other', value: 'other' },
        ]}
        label="Choose plugins"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    try {
      act(() => view.stdin.write('Alpha Beta'));
      expect(view.lastFrame()).toContain('Search: Alpha Beta');
      expect(view.lastFrame()).toContain('Tab toggle · Space search');

      act(() => view.stdin.write('\t'));
      expect(view.lastFrame()).toContain('[x] Alpha Beta');
      act(() => view.stdin.write('\r'));
      expect(onSubmit).toHaveBeenCalledWith(['alpha']);
    } finally {
      view.unmount();
    }
  });
});
