import { mkdir, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { setupPlugins } from '#setup/plugins';
import { setupTools } from '#setup/sections';

import { driveInk } from '../fixtures/ink.js';
import { createFilesystemSprite } from '../mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

import type { SetupContext } from '#setup/context';

const disabled = { tailscale: false, exitNode: false, cliproxyapi: false };

function setupContext(
  options: SetupContext['options'],
): Omit<SetupContext, 'interaction'> {
  return {
    options,
    input: { integrations: disabled, runtimeEnv: {}, sources: {}, missing: [] },
    integrations: disabled,
    tailscaleEnrolled: false,
    initialInstallation: true,
    mutation: { started: false },
  };
}

describe('fn:setupTools consent', () => {
  it('should leave a selected update unchanged when real Ink consent is declined', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-tools-decline-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const context = setupContext({});
    const observed = await driveInk(
      async (interaction) => setupTools(sprite, { ...context, interaction }),
      [
        { waitFor: 'Managed tools', input: 'Update tools now' },
        { waitFor: 'Search: Update tools now', input: '\r' },
        { waitFor: 'Install latest stable tools and restart', input: 'n' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(3);
    expect(observed.result).toEqual({ tools: 'unchanged' });
    expect(context.mutation.started).toBe(false);
    expect(sprite.execFile).not.toHaveBeenCalled();
  });

  it('should apply the selected guest update under --yes without host updater execution', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-tools-yes-'),
    );
    await mkdir(join(directory.path, 'opt/agent-sprite'), { recursive: true });
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: vi.fn<Sprite['execFile']>(async () => ({
        stdout: 'test-version\n',
        stderr: '',
        exitCode: 0,
      })),
    });
    const context = setupContext({ yes: true });
    const observed = await driveInk(
      async (interaction) => setupTools(sprite, { ...context, interaction }),
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
      expect.arrayContaining(['agent-sprite-transaction', '1']),
      { tty: false },
    );
    expect(
      await sprite.filesystem().exists('/opt/agent-sprite/install-tools.js'),
    ).toBe(true);
  });
});

describe('fn:setupPlugins removal consent', () => {
  it('should not queue an unapproved marketplace removal', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-plugin-decline-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const context = setupContext({ harness: 'claude' });
    const observed = await driveInk(
      async (interaction) => setupPlugins(sprite, { ...context, interaction }),
      [
        { waitFor: 'claude plugin action', input: 'Remove marketplace' },
        { waitFor: 'Search: Remove marketplace', input: '\r' },
        { waitFor: 'Native marketplace source/ref', input: 'old-market' },
        { waitFor: 'old-market', input: '\r' },
        { waitFor: 'Remove old-market from claude?', input: 'n' },
        {
          waitFor: 'claude plugin action',
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
      join(tmpdir(), 'agent-sprite-plugin-yes-'),
    );
    await mkdir(join(directory.path, 'opt/agent-sprite'), { recursive: true });
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
    const context = setupContext({ harness: 'claude', yes: true });
    const observed = await driveInk(
      async (interaction) => setupPlugins(sprite, { ...context, interaction }),
      [
        { waitFor: 'claude plugin action', input: 'Remove marketplace' },
        { waitFor: 'Search: Remove marketplace', input: '\r' },
        { waitFor: 'Native marketplace source/ref', input: 'old-market' },
        { waitFor: 'old-market', input: '\r' },
        {
          waitFor: 'claude plugin action',
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
