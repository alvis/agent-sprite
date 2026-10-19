import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createActivityController } from '#cli/activity';
import { rememberSecret } from '#kernel/redaction';

describe('fn:createActivityController', () => {
  it('should track nested live stages and leave redacted completion lines', () => {
    const output = new PassThrough();
    const secret = 'pol03-activity-private-token';
    rememberSecret(secret);
    const activity = createActivityController({
      output,
      options: { stagesOwnProgress: true },
      onChange: () => undefined,
      active: () => true,
    });

    activity.publish({ stage: 'setup', message: 'Running', phase: 'start' });
    expect(activity.current()).toMatchObject({ stage: 'setup' });
    expect(output.read()).toBeNull();

    activity.publish({
      stage: 'setup.native',
      message: 'Running',
      phase: 'start',
    });
    expect(activity.current()).toMatchObject({ stage: 'setup.native' });
    activity.publish({
      stage: 'setup.native',
      message: `Finished ${secret}`,
      phase: 'complete',
      outcome: 'ok',
    });
    expect(activity.current()).toMatchObject({ stage: 'setup' });
    const nestedLine = String(output.read());
    expect(nestedLine).toContain('setup.native');
    expect(nestedLine).toContain('[REDACTED]');
    expect(nestedLine).not.toContain(secret);

    activity.publish({
      stage: 'setup',
      message: 'Finished setup',
      phase: 'complete',
      outcome: 'ok',
    });
    expect(activity.current()).toBeUndefined();
    expect(String(output.read())).toContain('setup');
  });

  it('should suppress routine progress when quiet and stop after the session closes', () => {
    const output = new PassThrough();
    const quiet = createActivityController({
      output,
      options: { quiet: true },
      onChange: () => undefined,
      active: () => true,
    });
    quiet.publish({ stage: 'create', message: 'Running', phase: 'start' });
    quiet.publish({ stage: 'create', message: 'Done', phase: 'complete' });
    expect(quiet.current()).toBeUndefined();
    expect(output.read()).toBeNull();

    const closed = createActivityController({
      output,
      options: {},
      onChange: () => undefined,
      active: () => false,
    });
    closed.publish({ stage: 'create', message: 'Running', phase: 'start' });
    expect(closed.current()).toBeUndefined();
    expect(output.read()).toBeNull();
  });
});
