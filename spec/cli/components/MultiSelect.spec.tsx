import { render } from 'ink-testing-library';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MultiSelect } from '#cli/components/MultiSelect';

describe('rc:MultiSelect', () => {
  it('should recover from a search with no matches without selecting unavailable input', () => {
    const onSubmit = vi.fn<(values: string[]) => void>();
    const view = render(
      <MultiSelect
        choices={[{ label: 'Alpha', value: 'alpha' }]}
        label="Plugins"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    try {
      act(() => view.stdin.write('missing'));
      act(() => view.stdin.write('\t'));
      expect({
        submissions: onSubmit.mock.calls,
        frame: view.lastFrame(),
      }).toEqual({
        submissions: [],
        frame: expect.stringMatching(/no match/iu),
      });
      for (let index = 0; index < 7; index++) {
        act(() => view.stdin.write(index === 0 ? '\x08' : '\x7f'));
      }
      for (const key of ['\x18', '\x1bq', '\t', '\r']) {
        act(() => view.stdin.write(key));
      }

      expect(onSubmit.mock.calls).toEqual([[['alpha']]]);
    } finally {
      view.unmount();
    }
  });

  it('should keep an empty selection pending on unrelated keys and cancel only after returning to the menu', async () => {
    const onSubmit = vi.fn<(values: string[]) => void>();
    const onCancel = vi.fn<(back?: boolean) => void>();
    const view = render(
      <MultiSelect
        choices={[]}
        label="Plugins"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );
    try {
      act(() => view.stdin.write('\r'));
      act(() => view.stdin.write('z'));
      expect({
        submissions: onSubmit.mock.calls,
        cancellations: onCancel.mock.calls,
      }).toEqual({
        submissions: [],
        cancellations: [],
      });
      act(() => view.stdin.write('\x1b'));
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Plugins'));
      act(() => view.stdin.write('\x1b'));

      await vi.waitFor(() => expect(onCancel.mock.calls).toEqual([[true]]));
    } finally {
      view.unmount();
    }
  });

  it('should deselect defaults, refuse unavailable choices, and submit the remaining selection', () => {
    const onSubmit = vi.fn<(values: string[]) => void>();
    const view = render(
      <MultiSelect
        backLabel="parent menu"
        choices={[
          { label: 'Alpha', value: 'alpha', isPreselected: true },
          {
            label: 'Beta',
            value: 'beta',
            description: 'Restricted plugin',
            disabledReason: 'unsupported-platform',
          },
          { label: 'Gamma', value: 'gamma' },
        ]}
        description="Choose compatible plugins"
        label="Plugins"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    try {
      act(() => view.stdin.write(' '));
      act(() => view.stdin.write('\x1b[B'));
      act(() => view.stdin.write(' '));
      expect({
        submissions: onSubmit.mock.calls,
        frame: view.lastFrame(),
      }).toEqual({
        submissions: [],
        frame: expect.stringContaining('unsupported-platform'),
      });
      for (const key of ['\x1b[B', '\t', '\x1b[A', '\x1b[A', ' ', '\r']) {
        act(() => view.stdin.write(key));
      }

      expect(onSubmit.mock.calls).toEqual([[['gamma', 'alpha']]]);
    } finally {
      view.unmount();
    }
  });

  it('should select beyond the initial viewport and stop upward movement at the first choice', () => {
    const choices = Array.from({ length: 12 }, (_, index) => ({
      label: `Plugin ${index}`,
      value: `plugin-${index}`,
    }));
    const onSubmit = vi.fn<(values: string[]) => void>();
    const view = render(
      <MultiSelect
        choices={choices}
        label="Plugins"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    try {
      for (let index = 0; index < 10; index++) {
        act(() => view.stdin.write('\x1b[B'));
      }
      act(() => view.stdin.write(' '));
      for (let index = 0; index < 12; index++) {
        act(() => view.stdin.write('\x1b[A'));
      }
      act(() => view.stdin.write(' '));
      act(() => view.stdin.write('\r'));

      expect(onSubmit.mock.calls).toEqual([[['plugin-10', 'plugin-0']]]);
    } finally {
      view.unmount();
    }
  });

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
