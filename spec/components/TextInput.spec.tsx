import { render } from 'ink-testing-library';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SecretInput, TextInput } from '#components/TextInput';

describe('rc:TextInput', () => {
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
