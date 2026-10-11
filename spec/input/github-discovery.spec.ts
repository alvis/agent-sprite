import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { discoverGithubToken } from '#input/github';
import { redactResolved } from '#utilities/redaction';

describe('fn:discoverGithubToken', () => {
  it('should register a generated token returned by the installed gh process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-sprite-gh-'));
    const token = 'saf08-generated-gh-process-token';
    vi.stubEnv('GH_CONFIG_DIR', directory);
    vi.stubEnv('GH_TOKEN', token);
    try {
      const discovered = await discoverGithubToken({});

      expect(discovered).toBe(token);
      expect(redactResolved(`gh returned ${discovered}`)).toBe(
        'gh returned [REDACTED]',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
