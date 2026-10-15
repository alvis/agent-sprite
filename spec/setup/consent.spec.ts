import { mkdir, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { setupPlugins } from '#setup/plugins';
import { setupTools } from '#setup/tools';

import { driveInk } from '../fixtures/ink.js';
import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile.js';
import {
  createFilesystemSprite,
  guestOf,
  workstationOf,
} from '../mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

import type { SetupContext } from '#setup/context';

function setupContext(
  sprite: Sprite,
  options: SetupContext['options'],
): Omit<SetupContext, 'interaction'> {
  return {
    ...workstationOf(sprite),
    options,
    input: {
      profile: DISABLED_NETWORK_PROFILE,
      runtimeEnv: {},
      sources: {},
      missing: [],
    },
    profile: DISABLED_NETWORK_PROFILE,
    persistsProfile: false,
    isReleaseChanged: false,
    networkEnrolled: false,
    mutation: { started: false },
  };
}

describe('fn:setupTools consent', () => {
  it('should leave a selected update unchanged when real Ink consent is declined', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tools-decline-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const context = setupContext(sprite, {});
    const observed = await driveInk(
      async (interaction) =>
        setupTools(guestOf(sprite), { ...context, interaction }),
      [
        { waitFor: 'Managed tools', input: 'Update tools now' },
        { waitFor: 'Search: Update tools now', input: '\r' },
        { waitFor: 'Install latest stable tools now', input: 'n' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(3);
    expect(observed.result).toEqual({ tools: 'unchanged' });
    expect(context.mutation.started).toBe(false);
    expect(sprite.execFile).not.toHaveBeenCalled();
  });

  it('should apply the selected guest update under --yes without host updater execution', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tools-yes-'),
    );
    await mkdir(join(directory.path, 'opt/open-agent'), { recursive: true });
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: vi.fn<Sprite['execFile']>(async () => ({
        stdout: 'test-version\n',
        stderr: '',
        exitCode: 0,
      })),
    });
    const context = setupContext(sprite, { yes: true });
    const observed = await driveInk(
      async (interaction) =>
        setupTools(guestOf(sprite), { ...context, interaction }),
      [
        { waitFor: 'Managed tools', input: 'Update tools now' },
        { waitFor: 'Search: Update tools now', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(2);
    expect(observed.result).toEqual({ tools: 'updated' });
    expect(context.mutation.started).toBe(true);
    expect(sprite.spawn).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      expect.arrayContaining(['open-agent-transaction', '1']),
      { tty: false },
    );
    expect(
      await sprite
        .filesystem()
        .exists('/opt/open-agent/guest/install-tools.js'),
    ).toBe(true);
  });
});

describe('fn:setupPlugins removal consent', () => {
  it('should not queue an unapproved marketplace removal', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-plugin-decline-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const context = setupContext(sprite, { pluginHarness: 'claude' });
    const observed = await driveInk(
      async (interaction) =>
        setupPlugins(guestOf(sprite), { ...context, interaction }),
      [
        { waitFor: 'Claude plugin action', input: 'Remove marketplace' },
        { waitFor: 'Search: Remove marketplace', input: '\r' },
        { waitFor: 'Native marketplace source/ref', input: 'old-market' },
        { waitFor: 'old-market', input: '\r' },
        { waitFor: 'Remove old-market from Claude?', input: 'n' },
        {
          waitFor: 'Claude plugin action',
          input: 'Apply queued actions and finish',
        },
        { waitFor: 'Search: Apply queued actions and finish', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(7);
    expect(observed.result.plugins.claude).toBe('preserved');
    expect(context.mutation.started).toBe(false);
    expect(sprite.execFile).not.toHaveBeenCalled();
  });

  it('should apply an explicitly selected removal under --yes', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-plugin-yes-'),
    );
    await mkdir(join(directory.path, 'opt/open-agent'), { recursive: true });
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
        stdout:
          args.includes('marketplace') && args.includes('list')
            ? '[{"name":"old-market","repo":"old-market"}]'
            : '[]',
        stderr: '',
        exitCode: 0,
      })),
    });
    const context = setupContext(sprite, {
      pluginHarness: 'claude',
      yes: true,
    });
    const observed = await driveInk(
      async (interaction) =>
        setupPlugins(guestOf(sprite), { ...context, interaction }),
      [
        { waitFor: 'Claude plugin action', input: 'Remove marketplace' },
        { waitFor: 'Search: Remove marketplace', input: '\r' },
        { waitFor: 'Native marketplace source/ref', input: 'old-market' },
        { waitFor: 'old-market', input: '\r' },
        {
          waitFor: 'Claude plugin action',
          input: 'Apply queued actions and finish',
        },
        { waitFor: 'Search: Apply queued actions and finish', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(6);
    expect(observed.result.plugins.claude).toBe('applied');
    expect(context.mutation.started).toBe(true);
    expect(
      vi
        .mocked(sprite.execFile)
        .mock.calls.some(([, args]) => args?.includes('old-market')),
    ).toBe(true);
  });
});
