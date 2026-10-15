import { mkdtempDisposable, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { awakeCommandScript } from '#guest/idle/command';
import {
  inspectGovernor,
  installAwakeCommand,
} from '#integrations/guest/governor';

import { createFilesystemSprite, guestOf } from '../../mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

import type { GovernorReport } from '#guest/idle/state';

const REPORT: GovernorReport = {
  recorded: true,
  state: {
    version: 1,
    updatedAt: '2026-10-13T12:00:00.000Z',
    keepAwakeMode: 'native-deadline',
    idleTimeoutMinutes: 5,
    holdMaxMinutes: 60,
    lastHeartbeat: '2026-10-13T12:00:00.000Z',
    holds: [],
    openHolds: 0,
    deadline: '2026-10-13T12:05:00.000Z',
    sleepPermitted: false,
    diagnostics: [],
  },
};

describe('fn:installAwakeCommand', () => {
  it('should install the command root-owned, the shared awake directory for root and the agent group, and the managed one only root writes', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-awake-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    await installAwakeCommand(guestOf(sprite));
    const command = join(directory.path, 'opt/open-agent/bin/open-agent-awake');

    // each guest command runs through a wrapper, and the install command line
    // is its tail
    const installs = execute.mock.calls.flatMap(([, args = []]) =>
      args.includes('/usr/bin/install')
        ? [args.slice(args.indexOf('/usr/bin/install'))]
        : [],
    );

    expect(installs).toEqual([
      expect.arrayContaining(['/opt/open-agent/bin']),
      [
        '/usr/bin/install',
        '-d',
        '-o',
        'root',
        '-g',
        'root',
        '-m',
        '0755',
        '/opt/open-agent/run',
      ],
      [
        '/usr/bin/install',
        '-d',
        '-o',
        'root',
        '-g',
        'agent',
        '-m',
        '2770',
        '/opt/open-agent/run/awake',
      ],
      [
        '/usr/bin/install',
        '-d',
        '-o',
        'root',
        '-g',
        'agent',
        '-m',
        '2750',
        '/opt/open-agent/run/awake-root',
      ],
    ]);
    expect(await readFile(command, 'utf8')).toBe(awakeCommandScript());
    expect((await stat(command)).mode & 0o7777).toBe(0o755);
  });
});

describe('fn:inspectGovernor', () => {
  it.each([
    ['a valid report', JSON.stringify(REPORT), 0, REPORT],
    [
      'a report with a forged field',
      JSON.stringify({ ...REPORT, state: { ...REPORT.state, openHolds: -1 } }),
      0,
      { recorded: false, reason: 'the governor report is unavailable' },
    ],
    [
      'a report with a terminal escape in a diagnostic',
      JSON.stringify({
        ...REPORT,
        state: { ...REPORT.state, diagnostics: ['refused\u001b[2J'] },
      }),
      0,
      { recorded: false, reason: 'the governor report is unavailable' },
    ],
    [
      'a report with a C1 control character in an adapter failure',
      JSON.stringify({
        ...REPORT,
        state: {
          ...REPORT.state,
          adapter: {
            at: REPORT.state.updatedAt,
            action: 'apply-deadline',
            failure: 'refused\u009b31m',
          },
        },
      }),
      0,
      { recorded: false, reason: 'the governor report is unavailable' },
    ],
    [
      'a failed report entry',
      JSON.stringify(REPORT),
      1,
      { recorded: false, reason: 'the governor report is unavailable' },
    ],
    [
      'output that is not JSON',
      'node: not found',
      0,
      { recorded: false, reason: 'the governor report is unavailable' },
    ],
  ])('should read %s', async (...[, stdout, exitCode, expected]) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-awake-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: vi.fn<Sprite['execFile']>(async () => ({
        stdout,
        stderr: '',
        exitCode,
      })),
    });

    await expect(inspectGovernor(guestOf(sprite))).resolves.toEqual(expected);
  });
});
