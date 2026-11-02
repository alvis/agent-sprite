import {
  mkdir,
  mkdtempDisposable,
  readdir,
  rmdir,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { execa } from 'execa';
import { describe, expect, it, vi } from 'vitest';

import { flyctlAgent } from '#adapters/drivers/providers/fly-machine/agent';

import type { Options, Result, ResultPromise } from 'execa';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = { ...(await importOriginal<typeof import('node:fs/promises')>()) };
  const entries = vi.fn(fs.readdir);

  return {
    ...fs,
    mkdir: vi.fn(fs.mkdir) as typeof fs.mkdir,
    stat: vi.fn(fs.stat) as typeof fs.stat,
    readdir: entries as typeof entries & typeof fs.readdir,
    rmdir: vi.fn(fs.rmdir),
  } satisfies Partial<typeof import('node:fs/promises')>;
});
vi.mock(
  'node:timers/promises',
  () =>
    ({
      setTimeout: vi.fn(
        async <T>(_: number | undefined, value: T) => value,
      ) as typeof import('node:timers/promises').setTimeout,
    }) satisfies Partial<typeof import('node:timers/promises')>,
);
vi.mock(
  '#adapters/drivers/providers/fly-machine/flyctl',
  () =>
    ({
      FLYCTL: 'fly',
      prepareFlyctlDirectory: vi.fn(
        async () => process.env.AGENT_TEST_DIRECTORY!,
      ),
      flyctlEnvironment: vi.fn(() => ({})),
    }) satisfies Partial<
      typeof import('#adapters/drivers/providers/fly-machine/flyctl')
    >,
);
vi.mock('execa', () => {
  const run = vi.fn<
    (
      program: string,
      args: readonly string[],
      options?: Options,
    ) => ResultPromise
  >(
    (): ResultPromise =>
      Promise.resolve({
        exitCode: 0,
        stdout: '',
        stderr: '',
      } satisfies Partial<Result> as Result) as ResultPromise,
  );

  return {
    execa: run as typeof run & typeof import('execa').execa,
  } satisfies Partial<typeof import('execa')>;
});

describe('Fly agent session registry', () => {
  it('should recover session accounting after lock acquisition fails', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fly-agent-test-'),
    );
    vi.stubEnv('AGENT_TEST_DIRECTORY', directory.path);
    const denied = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    vi.mocked(mkdir).mockRejectedValueOnce(denied);
    const session = vi.fn(async () => 'connected');

    await expect(flyctlAgent.hold(session)).rejects.toBe(denied);
    expect(session).not.toHaveBeenCalled();
    expect(await flyctlAgent.hold(session)).toBe('connected');
    expect(execa).toHaveBeenCalledWith(
      'fly',
      ['agent', 'stop'],
      expect.objectContaining({ extendEnv: false }),
    );
  });

  it('should serialize concurrent acquisitions and stop only after the last session ends', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fly-agent-test-'),
    );
    vi.stubEnv('AGENT_TEST_DIRECTORY', directory.path);
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    const started = vi.fn(async (result: Promise<string>) => result);
    const one = flyctlAgent.hold(async () => started(first.promise));
    const two = flyctlAgent.hold(async () => started(second.promise));
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2));
    first.resolve('first');

    expect(await one).toBe('first');
    expect(execa).not.toHaveBeenCalled();
    second.resolve('second');
    expect(await two).toBe('second');
    expect(vi.mocked(execa).mock.calls).toHaveLength(1);
  });
});

describe('Fly agent lock recovery', () => {
  it('should retry when a contended lock disappears before it can be inspected', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fly-agent-test-'),
    );
    vi.stubEnv('AGENT_TEST_DIRECTORY', directory.path);
    vi.mocked(mkdir).mockRejectedValueOnce(
      Object.assign(new Error('held'), { code: 'EEXIST' }),
    );

    expect(await flyctlAgent.hold(async () => 'connected')).toBe('connected');
    expect(delay).toHaveBeenCalledWith(100);
  });

  it('should recover a stale lock even if its first removal fails', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fly-agent-test-'),
    );
    vi.stubEnv('AGENT_TEST_DIRECTORY', directory.path);
    const lock = join(directory.path, 'agent.lock');
    await mkdir(lock);
    const stale = new Date(Date.now() - 121000);
    await utimes(lock, stale, stale);
    vi.mocked(rmdir).mockRejectedValueOnce(
      Object.assign(new Error('busy'), { code: 'EBUSY' }),
    );

    expect(await flyctlAgent.hold(async () => 'connected')).toBe('connected');
    expect(delay).toHaveBeenCalledWith(100);
  });

  it('should retain the session result when releasing its lock fails', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fly-agent-test-'),
    );
    vi.stubEnv('AGENT_TEST_DIRECTORY', directory.path);
    const remove = vi.mocked(rmdir).getMockImplementation()!;
    vi.mocked(rmdir)
      .mockImplementationOnce(remove)
      .mockRejectedValueOnce(new Error('lock removal failed'));

    expect(await flyctlAgent.hold(async () => 'connected')).toBe('connected');
  });
});

describe('Fly agent registry recovery', () => {
  it('should forget unreadable registry names and stop the unused agent', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fly-agent-test-'),
    );
    vi.stubEnv('AGENT_TEST_DIRECTORY', directory.path);
    const sessions = join(directory.path, 'sessions');
    await mkdir(sessions);
    await writeFile(join(sessions, '.DS_Store'), '');

    expect(await flyctlAgent.hold(async () => 'connected')).toBe('connected');
    expect(await readdir(sessions)).toEqual([]);
    expect(vi.mocked(execa).mock.calls).toHaveLength(1);
  });

  it('should preserve another live session when its process cannot be signaled by this account', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fly-agent-test-'),
    );
    vi.stubEnv('AGENT_TEST_DIRECTORY', directory.path);
    const sessions = join(directory.path, 'sessions');
    await mkdir(sessions);
    await writeFile(join(sessions, '12345'), '');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });

    expect(await flyctlAgent.hold(async () => 'connected')).toBe('connected');
    expect(await readdir(sessions)).toEqual(['12345']);
    expect(execa).not.toHaveBeenCalled();
  });

  it('should stop the agent when its session directory disappears during release', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fly-agent-test-'),
    );
    vi.stubEnv('AGENT_TEST_DIRECTORY', directory.path);
    vi.mocked(readdir).mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'ENOENT' }),
    );

    expect(await flyctlAgent.hold(async () => 'connected')).toBe('connected');
    expect(vi.mocked(execa).mock.calls).toHaveLength(1);
  });
});
