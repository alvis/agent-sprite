import { describe, expect, it, vi } from 'vitest';

import { providerPreflight } from '#application/catalog/preflight';

import { dependencies } from '../../mocks/dependencies';

const host = {
  ...dependencies.host,
  tools: { findTool: vi.fn(async () => '/fixture/fly') },
  run: vi.fn<typeof dependencies.host.run>(async () => {
    throw new Error('Version process failed');
  }),
} satisfies typeof dependencies.host;

describe('fn:providerPreflight', () => {
  it('should return an actionable prerequisite problem when a discovered tool cannot report its version', async () => {
    const problems = await providerPreflight(
      { ...dependencies, host },
      'fly-machine',
      {},
    );

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: 'fly',
          problem: expect.stringMatching(/did not report a version/),
        }),
      ]),
    );
  });
});
