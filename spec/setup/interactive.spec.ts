import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpritesClient } from '@fly/sprites';
import { parse } from 'smol-toml';
import { describe, expect, it, vi } from 'vitest';

import { MANAGED_LABEL, SCHEMA_LABEL } from '#integrations/sprites';
import { setupWorkstation } from '#setup';
import { setupPlugins } from '#setup/plugins';
import { setupTools } from '#setup/sections';

import { driveInk } from '../fixtures/ink.js';
import { createFilesystemSprite } from '../mocks/sprites.js';

import type { SetupContext } from '#setup/context';

const integrations = { tailscale: false, exitNode: false, cliproxyapi: false };

describe('workflow:scoped setup', () => {
  it('should view recorded tool versions and declines an update without guest mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sprite-setup-'));
    try {
      const sprite = createFilesystemSprite({ root });
      await mkdir(join(root, 'opt/agent-sprite'), { recursive: true });
      await writeFile(
        join(root, 'opt/agent-sprite/manifest.json'),
        JSON.stringify({
          schema: 1,
          createdAt: '2026-10-01',
          installedVersions: { node: '24.9.0' },
          lastSuccessfulUpdate: '2026-10-01T00:00:00Z',
          integrations,
        }),
      );
      const context: SetupContext = {
        options: { localCredentials: false },
        input: { integrations, runtimeEnv: {}, sources: {}, missing: [] },
        integrations,
        tailscaleEnrolled: false,
        initialInstallation: false,
        mutation: { started: false },
      };
      const observed = await driveInk(
        async (interaction) => {
          context.interaction = interaction;
          const versions = await setupTools(sprite, context);
          const declined = await setupTools(sprite, context);

          return { versions, declined };
        },
        [
          { waitFor: 'Managed tools', input: '\r' },
          { waitFor: 'Managed tools', input: 'Update tools now' },
          { waitFor: 'Search: Update tools now', input: '\r' },
          { waitFor: 'Install latest stable tools and restart', input: '\r' },
        ],
      );

      expect(observed.matchedSteps, observed.output).toBe(4);
      expect(observed.result.versions).toMatchObject({
        tools: {
          status: 'recorded versions',
          installedVersions: { node: '24.9.0' },
        },
      });
      expect(observed.result.declined).toEqual({ tools: 'unchanged' });
      expect(sprite.filesystem().writeFile).not.toHaveBeenCalled();
      expect(context.mutation.started).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('should return from tools to sections, then skips Git identity without mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sprite-setup-'));
    vi.stubEnv('HOME', root);
    try {
      const sprite = Object.assign(createFilesystemSprite({ root }), {
        id: 'sprite-temporary',
        organizationName: 'test',
        labels: [MANAGED_LABEL, SCHEMA_LABEL],
      });
      const client = new SpritesClient('test-token');
      vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);
      await mkdir(join(root, 'opt/agent-sprite'), { recursive: true });
      await writeFile(
        join(root, 'opt/agent-sprite/manifest.json'),
        JSON.stringify({
          schema: 1,
          createdAt: '2026-10-01',
          installedVersions: {},
          integrations,
        }),
      );
      const observed = await driveInk(
        async (interaction) =>
          setupWorkstation(
            {
              command: 'setup',
              machine: 'temporary',
              options: {
                section: 'tools',
                localCredentials: false,
                github: false,
                gitName: 'Ada',
                gitEmail: 'ada@example.test',
              },
            },
            client,
            interaction,
          ),
        [
          { waitFor: 'Managed tools', input: '\x1b' },
          { waitFor: 'Choose setup section', input: 'Git / Jujutsu' },
          { waitFor: 'Search: Git / Jujutsu', input: '\r' },
          { waitFor: 'Git commit identity', input: 'Skip Git' },
          { waitFor: 'Search: Skip Git', input: '\r' },
        ],
      );

      expect(observed.matchedSteps, observed.output).toBe(5);
      expect(observed.result).toMatchObject({
        ok: true,
        data: { section: 'git', gitIdentity: 'preserved' },
      });
      expect(sprite.filesystem().writeFile).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('should recover plugin harness, action and value choices while retaining queued actions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sprite-setup-'));
    try {
      const sprite = createFilesystemSprite({
        root,
        execute: async (_file, args = []) => ({
          stdout: args.includes('/usr/bin/id') ? '1000' : '[]',
          stderr: '',
          exitCode: 0,
        }),
      });
      const context: SetupContext = {
        options: { localCredentials: false },
        input: { integrations, runtimeEnv: {}, sources: {}, missing: [] },
        integrations,
        tailscaleEnrolled: false,
        initialInstallation: false,
        mutation: { started: false },
      };
      await mkdir(join(root, 'home/agent/.codex'), { recursive: true });
      await mkdir(join(root, 'opt/agent-sprite'), { recursive: true });
      await writeFile(
        join(root, 'home/agent/.codex/config.toml'),
        'model = "existing-model"',
      );
      const observed = await driveInk(
        async (interaction) =>
          setupPlugins(sprite, {
            ...context,
            interaction,
          }),
        [
          { waitFor: 'Select plugin harness', input: '\r' },
          { waitFor: 'claude plugin action', input: '\x1b' },
          { waitFor: 'Select plugin harness', input: 'Codex' },
          { waitFor: 'Search: Codex', input: '\r' },
          { waitFor: 'codex plugin action', input: 'Disable plugin' },
          { waitFor: 'Search: Disable plugin', input: '\r' },
          { waitFor: 'Native plugin identity:', input: '\x1b' },
          { waitFor: 'codex plugin action', input: 'Disable plugin' },
          { waitFor: 'Search: Disable plugin', input: '\r' },
          { waitFor: 'Native plugin identity:', input: 'coding@alvis' },
          { waitFor: 'coding@alvis', input: '\r' },
          { waitFor: 'Select plugin harness', input: 'Codex' },
          { waitFor: 'Search: Codex', input: '\r' },
          { waitFor: 'codex plugin action', input: 'Apply queued' },
          { waitFor: 'Search: Apply queued', input: '\r' },
        ],
      );
      const config = parse(
        await readFile(join(root, 'home/agent/.codex/config.toml'), 'utf8'),
      );

      expect(observed.matchedSteps, observed.output).toBe(15);
      expect(observed.result).toEqual({
        plugins: { claude: 'preserved', codex: 'applied' },
      });
      expect(config).toMatchObject({
        model: 'existing-model',
        plugins: {
          'coding@alvis': { enabled: false },
        },
      });
      expect(context.mutation.started).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
  it('should preserve Git identity when explicitly skipped without guest mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sprite-setup-'));
    vi.stubEnv('HOME', root);
    try {
      const sprite = Object.assign(createFilesystemSprite({ root }), {
        id: 'sprite-temporary',
        organizationName: 'test',
        labels: [MANAGED_LABEL, SCHEMA_LABEL],
      });
      const client = new SpritesClient('test-token');
      vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);
      await mkdir(join(root, 'opt/agent-sprite'), { recursive: true });
      await writeFile(
        join(root, 'opt/agent-sprite/manifest.json'),
        JSON.stringify({
          schema: 1,
          createdAt: '2026-10-01',
          installedVersions: {},
          integrations,
        }),
      );

      const result = await setupWorkstation(
        {
          command: 'setup',
          machine: 'temporary',
          options: {
            section: 'git',
            localCredentials: false,
            github: false,
            gitIdentity: false,
          },
        },
        client,
      );

      expect(result).toMatchObject({
        ok: true,
        data: { section: 'git', gitIdentity: 'preserved' },
      });
      expect(sprite.filesystem().writeFile).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should apply an explicit Codex plugin action through the real setup workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sprite-setup-'));
    try {
      const sprite = createFilesystemSprite({
        root,
        execute: async (_file, args = []) => ({
          stdout: args.includes('/usr/bin/id') ? '1000' : '[]',
          stderr: '',
          exitCode: 0,
        }),
      });
      const context: SetupContext = {
        options: {
          localCredentials: false,
          disableCodexPlugin: ['coding@alvis'],
        },
        input: { integrations, runtimeEnv: {}, sources: {}, missing: [] },
        integrations,
        tailscaleEnrolled: false,
        initialInstallation: false,
        mutation: { started: false },
      };
      await mkdir(join(root, 'home/agent/.codex'), { recursive: true });
      await mkdir(join(root, 'opt/agent-sprite'), { recursive: true });
      await writeFile(
        join(root, 'home/agent/.codex/config.toml'),
        'model = "existing-model"',
      );

      const outcome = await setupPlugins(sprite, context);
      const config = parse(
        await readFile(join(root, 'home/agent/.codex/config.toml'), 'utf8'),
      );

      expect(outcome).toEqual({
        plugins: { claude: 'preserved', codex: 'applied' },
      });
      expect(config.model).toBe('existing-model');
      expect(context.mutation.started).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
