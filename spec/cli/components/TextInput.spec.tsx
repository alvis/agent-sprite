import { render } from 'ink-testing-library';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SecretInput, TextInput } from '#cli/components/TextInput';

describe('rc:TextInput', () => {
  it('should ignore control and meta shortcuts while treating pasted line breaks as text separators', () => {
    const onSubmit = vi.fn<(value: string) => void>();
    const view = render(
      <TextInput label="Pasted value" onCancel={vi.fn()} onSubmit={onSubmit} />,
    );
    try {
      for (const input of ['\x18', '\x1bq', '\t', 'first\nsecond\rthird']) {
        act(() => view.stdin.write(input));
      }
      act(() => view.stdin.write('\r'));

      expect(onSubmit.mock.calls).toEqual([['firstsecondthird']]);
    } finally {
      view.unmount();
    }
  });

  it('should keep invalid input pending and preserve validation feedback when color is disabled', () => {
    const onSubmit = vi.fn<(value: string) => void>();
    const onCancel = vi.fn<(back?: boolean) => void>();
    const validate = (value: string): string | undefined =>
      value === 'ok' ? undefined : 'use-the-accepted-value';
    const view = render(
      <TextInput
        required
        description="A validated value"
        label="Value"
        validate={validate}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );
    try {
      act(() => view.stdin.write('\r'));
      expect({
        submissions: onSubmit.mock.calls,
        frame: view.lastFrame(),
      }).toEqual({
        submissions: [],
        frame: expect.stringMatching(/required/iu),
      });
      act(() => view.stdin.write('bad'));
      act(() => view.stdin.write('\r'));
      view.rerender(
        <TextInput
          noColor
          required
          description="A validated value"
          label="Value"
          validate={validate}
          onCancel={onCancel}
          onSubmit={onSubmit}
        />,
      );
      expect({
        submissions: onSubmit.mock.calls,
        frame: view.lastFrame(),
      }).toEqual({
        submissions: [],
        frame: expect.stringContaining('use-the-accepted-value'),
      });
      for (const key of ['\x01', '\x1b[3~', '\x1b[3~', '\x1b[3~', 'ok', '\r']) {
        act(() => view.stdin.write(key));
      }

      expect({
        submissions: onSubmit.mock.calls,
        frame: view.lastFrame(),
      }).toEqual({
        submissions: [['ok']],
        frame: expect.not.stringContaining('use-the-accepted-value'),
      });
    } finally {
      view.unmount();
    }
  });

  it.each([
    {
      behavior: 'bound arrow movement while inserting at the selected position',
      initial: 'ab',
      keys: [
        '\x1b[D',
        '\x1b[D',
        '\x1b[D',
        '\x1b[C',
        'X',
        '\x1b[C',
        '\x1b[C',
        'Y',
      ],
      expected: 'aXbY',
    },
    {
      behavior:
        'support beginning, end, backward, and forward editing shortcuts',
      initial: 'ab',
      keys: ['\x02', 'X', '\x06', 'Y', '\x01', 'S', '\x05', 'E'],
      expected: 'SaXbYE',
    },
    {
      behavior: 'delete whole graphemes without deleting before the beginning',
      initial: 'a👩‍💻b',
      keys: ['\x1b[D', '\x7f', '\x1b[3~', '\x01', '\x08'],
      expected: 'a',
    },
  ])('should $behavior', ({ initial, keys, expected }) => {
    const onSubmit = vi.fn<(value: string) => void>();
    const view = render(
      <TextInput
        defaultValue={initial}
        label="Editable value"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    try {
      for (const key of keys) {
        act(() => view.stdin.write(key));
      }
      act(() => view.stdin.write('\r'));

      expect(onSubmit.mock.calls).toEqual([[expected]]);
    } finally {
      view.unmount();
    }
  });

  it('should keep a visible caret and inserts at that point without color', () => {
    const onSubmit = vi.fn();
    const view = render(
      <TextInput
        noColor
        defaultValue="ac"
        label="Git name"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    try {
      expect(view.lastFrame()).toContain('Git name: ac│');
      act(() => view.stdin.write('\x1b[D'));
      act(() => view.stdin.write('b'));
      expect(view.lastFrame()).toContain('Git name: ab│c');
      act(() => view.stdin.write('\r'));
      expect(onSubmit).toHaveBeenCalledWith('abc');
      expect(view.lastFrame()).not.toContain('\u001b');
    } finally {
      view.unmount();
    }
  });

  it('should use the same hidden marker for different secret lengths while submitting the real values', () => {
    const shortSubmit = vi.fn();
    const short = render(
      <SecretInput
        noColor
        label="Access token"
        onCancel={vi.fn()}
        onSubmit={shortSubmit}
      />,
    );
    let shortFrame: string | undefined;
    try {
      act(() => short.stdin.write('a'));
      shortFrame = short.lastFrame();
      expect(shortFrame).toContain('Access token: (hidden) │');
      expect(shortFrame).not.toContain('•');
      act(() => short.stdin.write('\r'));
      expect(shortSubmit).toHaveBeenCalledWith('a');
    } finally {
      short.unmount();
    }

    const longSubmit = vi.fn();
    const long = render(
      <SecretInput
        noColor
        label="Access token"
        onCancel={vi.fn()}
        onSubmit={longSubmit}
      />,
    );
    try {
      act(() => long.stdin.write('long-secret-value'));
      expect(long.lastFrame()).toBe(shortFrame);
      expect(long.lastFrame()).not.toContain('long-secret-value');
      act(() => long.stdin.write('\r'));
      expect(longSubmit).toHaveBeenCalledWith('long-secret-value');
    } finally {
      long.unmount();
    }
  });
});
