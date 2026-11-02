import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { discoverGithubToken } from '#application/input/github-discovery';
import { redactResolved } from '#kernel/redaction';

import { dependencies } from '../../mocks/dependencies';

describe('fn:discoverGithubToken', () => {
  it('should treat an unavailable local gh session as absent discovery', async () => {
    const host = {
      ...dependencies.host,
      run: vi.fn<typeof dependencies.host.run>(async () => {
        throw new Error('gh unavailable');
      }),
    } satisfies typeof dependencies.host;

    await expect(discoverGithubToken({ host }, {})).resolves.toBeUndefined();
  });

  it('should register a generated token returned by the installed gh process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-agent-gh-'));
    const token = 'saf08-generated-gh-process-token';
    vi.stubEnv('GH_CONFIG_DIR', directory);
    vi.stubEnv('GH_TOKEN', token);
    try {
      const discovered = await discoverGithubToken(dependencies, {});

      expect(discovered).toBe(token);
      expect(redactResolved(`gh returned ${discovered}`)).toBe(
        'gh returned [REDACTED]',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
