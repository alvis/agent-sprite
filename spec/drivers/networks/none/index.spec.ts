import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { catalog } from '#core/catalog';
import { none } from '#drivers/networks/none/index';

import { createFilesystemSprite, guestOf } from '../../../mocks/sprites';

import type { Sprite } from '@fly/sprites';

/**
 * builds a guest that records every command it is asked to run
 * @param root directory backing the guest filesystem
 * @returns the guest and the recorded commands
 */
function recordingGuest(root: string) {
  const execute = vi.fn<Sprite['execFile']>(async () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
  }));
  const sprite = createFilesystemSprite({ root, execute });

  return { guest: guestOf(sprite), execute, sprite };
}

describe('drv:none', () => {
  it('should be the driver the catalog registers for the none network', () => {
    expect(catalog.networks.none).toBe(none);
  });

  it('should declare no daemon, tools, inputs or exit node support', () => {
    expect(none).toMatchObject({
      id: 'none',
      kind: 'networks',
      supportsExitNode: false,
      tools: [],
    });
    expect(none.daemon).toBeUndefined();
    expect(none.inputs).toBeUndefined();
  });

  it('should pass preflight without checking any caller input', async () => {
    await expect(
      none.preflight({ hostname: 'workstation', exitNode: '100.64.0.1' }),
    ).resolves.toEqual({ problems: [] });
  });

  it('should refuse to verify an exit node or issue a credential', async () => {
    await expect(
      none.verifyExitNode({ credential: 'unused' }, 'node'),
    ).rejects.toThrow('No private network is selected');
    await expect(
      none.issueCredential({ credential: 'unused' }),
    ).rejects.toThrow('No private network is selected');
  });

  it('should enroll, release, and clean up without touching the guest or the caller accounts', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-none-driver-'),
    );
    const { guest, execute, sprite } = recordingGuest(directory.path);
    const recordIdentity = vi.fn();

    await none.enroll(guest, { hostname: 'workstation', recordIdentity });
    await none.release(guest, { service: undefined, recordIdentity });
    await none.assertSafeTarget({
      identity: await none.identify(guest, {}),
      exitNode: '100.64.0.1',
    });

    await expect(
      none.cleanup({ identity: await none.identify(guest, {}) }),
    ).resolves.toEqual({ ok: true, status: 'no device identity recorded' });
    expect(recordIdentity).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(sprite.spawn).not.toHaveBeenCalled();
  });

  it('should report a neutral not-configured status without asking the guest', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-none-status-'),
    );
    const { guest, execute } = recordingGuest(directory.path);

    const status = await none.status(guest);

    expect(status).toEqual({
      online: false,
      skipped: true,
      reason: 'No private network is selected',
    });
    expect(await none.status(guest)).not.toBe(status);
    expect(none.matchesExitNode('100.64.0.1', status)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('should report readiness as skipped, never as a failure', () => {
    expect(
      none.readiness(
        { online: false, skipped: true },
        { isExitNodeEnabled: false },
      ),
    ).toEqual([{ name: 'private network', status: 'skipped' }]);
  });
});
