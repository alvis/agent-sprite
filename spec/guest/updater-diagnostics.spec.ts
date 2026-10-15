import { describe, expect, it } from 'vitest';

import {
  UpdateFailure,
  updaterFailureMessage,
} from '#guest/updater-diagnostics';

describe('fn:updaterFailureMessage', () => {
  it('should report only the fixed safe diagnostic from a recorded update failure', () => {
    const raw = new Error('private sprite-env response and account token');
    const failure = new UpdateFailure(
      'install-tools failed (exit 17); see /opt/open-agent/install-tools.log',
      { cause: raw },
    );

    const output = updaterFailureMessage(failure);
    expect(output).toMatch(/install-tools\b.*exit 17.*install-tools\.log/u);
    expect(output).not.toContain('private');
  });

  it.each([
    new Error('private sprite-env response and account token'),
    'private sprite-env response and account token',
    { name: 'UpdateFailure', message: 'private spoofed diagnostic' },
  ])('should use the generic diagnostic for an unrecorded failure', (error) => {
    const output = updaterFailureMessage(error);
    expect(output).toContain('installation manifest');
    expect(output).not.toContain('private');
  });
});
