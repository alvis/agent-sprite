import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runAwakeCommand } from '#guest/idle/awake';
import { parseAwakeArguments } from '#guest/idle/command';
import { readGovernorState } from '#guest/idle/state-file';

import {
  createIdleRoot,
  writeSettings,
  fixtureProvider,
} from '../../fixtures/idle-root';

const T0 = Date.parse('2026-10-13T12:00:00.000Z');

/**
 * stands in for a hook's standard input
 * @param text what the harness writes, if anything
 * @returns a readable stream of the text
 */
function hookInput(text = ''): Readable {
  return Readable.from(text === '' ? [] : [Buffer.from(text)]);
}

describe('fn:parseAwakeArguments', () => {
  it('should accept one action with a source and a session in either order', () => {
    expect(
      parseAwakeArguments([
        'hold-open',
        '--session',
        'thr_01:a.b-c',
        '--source',
        'codex',
      ]),
    ).toEqual({
      budgetMs: 8_000,
      event: { action: 'hold-open', source: 'codex', session: 'thr_01:a.b-c' },
    });
  });

  it('should take a run budget from --budget-ms', () => {
    expect(
      parseAwakeArguments([
        'hold-close',
        '--source',
        'codex',
        '--session',
        '-',
        '--budget-ms',
        '2000',
      ]),
    ).toEqual({
      budgetMs: 2_000,
      hook: { action: 'hold-close', source: 'codex' },
    });
  });

  it('should defer the session to the hook input for a session of -', () => {
    expect(
      parseAwakeArguments([
        'hold-open',
        '--source',
        'claude',
        '--session',
        '-',
      ]),
    ).toEqual({
      budgetMs: 8_000,
      hook: { action: 'hold-open', source: 'claude' },
    });
  });

  it.each([
    ['no arguments', []],
    ['an unknown action', ['sleep', '--source', 'claude', '--session', 's']],
  ])('should answer usage for %s', (_, args) => {
    expect(parseAwakeArguments(args)).toEqual({
      usage: expect.stringContaining('usage: open-agent-awake'),
    });
  });

  it.each([
    ['a missing session', ['heartbeat', '--source', 'claude']],
    [
      'a repeated option',
      [
        'heartbeat',
        '--source',
        'claude',
        '--source',
        'codex',
        '--session',
        's',
      ],
    ],
    [
      'an unexpected option',
      ['heartbeat', '--source', 'claude', '--session', 's', '--force', 'yes'],
    ],
    [
      'an option without a value',
      ['heartbeat', '--source', 'claude', '--session'],
    ],
    [
      'a source with a path',
      ['heartbeat', '--source', '../claude', '--session', 's'],
    ],
    [
      'an upper-case source',
      ['heartbeat', '--source', 'Claude', '--session', 's'],
    ],
    [
      'a session with a separator',
      ['heartbeat', '--source', 'claude', '--session', 'a/b'],
    ],
    [
      'an oversized session',
      ['heartbeat', '--source', 'claude', '--session', 's'.repeat(129)],
    ],
    [
      'a run budget of 999',
      [
        'heartbeat',
        '--source',
        'claude',
        '--session',
        's',
        '--budget-ms',
        '999',
      ],
    ],
    [
      'a run budget of 8001',
      [
        'heartbeat',
        '--source',
        'claude',
        '--session',
        's',
        '--budget-ms',
        '8001',
      ],
    ],
    [
      'a run budget of 2e3',
      [
        'heartbeat',
        '--source',
        'claude',
        '--session',
        's',
        '--budget-ms',
        '2e3',
      ],
    ],
    [
      'a run budget of 02000',
      [
        'heartbeat',
        '--source',
        'claude',
        '--session',
        's',
        '--budget-ms',
        '02000',
      ],
    ],
  ])('should refuse %s within the default run budget', (_, args) => {
    expect(parseAwakeArguments(args)).toEqual({
      budgetMs: 8_000,
      refused: expect.any(String),
    });
  });
});

describe('fn:runAwakeCommand', () => {
  it('should record an event and exit 0', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));

    const status = await runAwakeCommand(
      parseAwakeArguments([
        'heartbeat',
        '--source',
        'claude',
        '--session',
        's1',
      ]),
      async () => idle.context,
      hookInput(),
    );

    expect(status).toBe(0);
    expect(
      await readGovernorState(
        join(idle.root, 'run/awake'),
        idle.context.owners,
      ),
    ).toEqual({
      recorded: true,
      state: expect.objectContaining({
        lastHeartbeat: new Date(T0).toISOString(),
      }),
    });
  });

  it('should record a refused event without a heartbeat and exit 0', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));

    const status = await runAwakeCommand(
      parseAwakeArguments([
        'heartbeat',
        '--source',
        'claude',
        '--session',
        'a/b',
      ]),
      async () => idle.context,
      hookInput(),
    );

    expect(status).toBe(0);
    expect(
      await readGovernorState(
        join(idle.root, 'run/awake'),
        idle.context.owners,
      ),
    ).toEqual({
      recorded: true,
      state: expect.objectContaining({
        holds: [],
        diagnostics: [expect.stringContaining('refused an awake event')],
      }),
    });
  });

  it('should exit 0 when the event cannot be written', async () => {
    await using idle = await createIdleRoot(T0);
    await rm(join(idle.root, 'run/awake'), { recursive: true });

    const status = await runAwakeCommand(
      parseAwakeArguments([
        'hold-open',
        '--source',
        'claude',
        '--session',
        's1',
      ]),
      async () => idle.context,
      hookInput(),
    );

    expect(status).toBe(0);
    expect(await readdir(join(idle.root, 'run'))).toEqual(['awake-root']);
  });

  it('should exit 0 when the governor context cannot be built', async () => {
    const status = await runAwakeCommand(
      parseAwakeArguments([
        'hold-close',
        '--source',
        'claude',
        '--session',
        's1',
      ]),
      async () => {
        throw new Error('no guest root');
      },
      hookInput(),
    );

    expect(status).toBe(0);
  });

  it('should print the usage and exit 64 for a command line without a known action', async () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const context = vi.fn(async () => {
      throw new Error('a usage error never builds a context');
    });

    const status = await runAwakeCommand(
      parseAwakeArguments(['--help']),
      context,
      hookInput(),
    );

    expect(status).toBe(64);
    expect(write.mock.calls).toEqual([
      [expect.stringContaining('usage: open-agent-awake')],
    ]);
    expect(context.mock.calls).toEqual([]);
  });

  it('should take the session of a hook event from its input', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));

    const status = await runAwakeCommand(
      parseAwakeArguments([
        'hold-open',
        '--source',
        'claude',
        '--session',
        '-',
      ]),
      async () => idle.context,
      hookInput(JSON.stringify({ session_id: 'thr_01', hook_event_name: 'x' })),
    );

    expect(status).toBe(0);
    expect(
      await readGovernorState(
        join(idle.root, 'run/awake'),
        idle.context.owners,
      ),
    ).toEqual({
      recorded: true,
      state: expect.objectContaining({
        holds: [expect.objectContaining({ source: 'claude' })],
      }),
    });
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['a missing session_id', JSON.stringify({ hook_event_name: 'Stop' })],
    [
      'an oversized document',
      JSON.stringify({ session_id: 's'.repeat(70_000) }),
    ],
    ['no input at all', ''],
  ])('should count %s as idleness and exit 0', async (_, text) => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));

    const status = await runAwakeCommand(
      parseAwakeArguments([
        'hold-open',
        '--source',
        'claude',
        '--session',
        '-',
      ]),
      async () => idle.context,
      hookInput(text),
    );

    expect(status).toBe(0);
    expect(
      await readGovernorState(
        join(idle.root, 'run/awake'),
        idle.context.owners,
      ),
    ).toEqual({
      recorded: true,
      state: expect.objectContaining({
        holds: [],
        diagnostics: [expect.stringContaining('refused an awake event')],
      }),
    });
  });
});
