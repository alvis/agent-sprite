import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { openWorkstationSession } from '#adapters/guest/platform/session/open';
import { SetupConnection } from '#adapters/guest/session/connection';
import { registry } from '#composition/registry';

import { guestOf } from '../../../mocks/sprites';

import type { GuestSession, SessionCommand } from '#application/ports/session';
import type { OsRelease } from '#domain/guest';
import type { WorkstationRecord } from '#domain/workstation';

vi.mock(
  '#adapters/guest/platform/session/open',
  () =>
    ({
      openWorkstationSession: vi.fn<
        typeof import('#adapters/guest/platform/session/open').openWorkstationSession
      >(async () => ({
        release: RELEASE,
        pid: 51,
        run: vi.fn<GuestSession['run']>(async () => RESULT),
        [Symbol.asyncDispose]: vi.fn(async () => undefined),
      })),
    }) satisfies Partial<
      typeof import('#adapters/guest/platform/session/open')
    >,
);

const RELEASE: OsRelease = {
  family: 'debian',
  id: 'debian',
  versionId: '12',
  arch: 'x86_64',
  libc: 'glibc',
};

const WORKSTATION = {
  id: 'test',
  name: 'test',
  organization: 'test',
  state: 'running',
  metadata: { setup: 'incomplete' },
} satisfies WorkstationRecord;

const COMMAND = {
  argv: ['true'],
  timeoutMs: 1_000,
} satisfies SessionCommand;

const RESULT = { exitCode: 0, stdout: '[]', stderr: '' };

describe('cl:SetupConnection', () => {
  it('should open on first use, reuse the session, and release it once', async () => {
    const connection = new SetupConnection(
      registry.providers['fly-machine'],
      WORKSTATION,
    );

    expect(() => connection.release).toThrow();
    expect(() => connection.pid).toThrow();
    await expect(connection.run(COMMAND)).resolves.toEqual(RESULT);
    const session = await connection.open();
    const run = vi.mocked(session.run);
    const dispose = vi.mocked(session[Symbol.asyncDispose]);
    expect(await connection.open()).toBe(session);
    expect(connection).toMatchObject({ release: RELEASE, pid: session.pid });
    expect(run.mock.calls).toEqual([[COMMAND]]);
    expect(openWorkstationSession).toHaveBeenCalledOnce();

    await connection[Symbol.asyncDispose]();
    await connection.close();
    expect(dispose.mock.calls).toEqual([[]]);
    expect(() => connection.release).toThrow();
  });

  it('should reopen after losing a session and supersede its process', async () => {
    const replacement = {
      release: RELEASE,
      pid: 53,
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;
    const connection = new SetupConnection(
      registry.providers['fly-machine'],
      WORKSTATION,
    );
    const lost = await connection.open();
    vi.mocked(openWorkstationSession).mockImplementationOnce(
      async () => replacement,
    );

    await expect(connection.reopen(lost.pid)).resolves.toBe(replacement);
    expect(openWorkstationSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ supersedes: lost.pid }),
    );
  });

  it('should lend a session without letting the borrower close it', async () => {
    const connection = new SetupConnection(
      registry.providers['fly-machine'],
      WORKSTATION,
    );

    const loan = await connection.lend();
    const session = await connection.open();
    const run = vi.mocked(session.run);
    const dispose = vi.mocked(session[Symbol.asyncDispose]);
    expect(loan).toMatchObject({ release: RELEASE, pid: session.pid });
    await expect(loan.run(COMMAND)).resolves.toEqual(RESULT);
    await loan[Symbol.asyncDispose]();
    await expect(connection.run(COMMAND)).resolves.toEqual(RESULT);
    expect(dispose.mock.calls).toEqual([]);
    expect(run.mock.calls).toEqual([[COMMAND], [COMMAND]]);

    await connection.close();
    expect(dispose.mock.calls).toEqual([[]]);
  });

  it('should lend a replacement that supersedes a lost shell', async () => {
    const replacement = {
      release: RELEASE,
      pid: 56,
      run: async () => RESULT,
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;
    const connection = new SetupConnection(
      registry.providers['fly-machine'],
      WORKSTATION,
    );
    const lost = await connection.open();
    const lostDispose = vi.mocked(lost[Symbol.asyncDispose]);
    vi.mocked(openWorkstationSession).mockImplementationOnce(
      async () => replacement,
    );

    const loan = await connection.lend(lost.pid);

    expect(loan).toMatchObject({ release: RELEASE, pid: replacement.pid });
    await expect(loan.run(COMMAND)).resolves.toEqual(RESULT);
    expect(lostDispose.mock.calls).toEqual([[]]);
    expect(openWorkstationSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ supersedes: lost.pid }),
    );
  });

  it('should run guest commands through the session and use provider services', async () => {
    const channel = guestOf(
      new Sprite('test', new SpritesClient('test-token')),
    );
    vi.spyOn(registry.providers.sprite, 'openGuest').mockImplementationOnce(
      async () => channel,
    );
    const connection = new SetupConnection(
      registry.providers.sprite,
      WORKSTATION,
    );

    const guest = await connection.guest();
    const session = await connection.open();

    await expect(
      guest.exec({ program: 'printf', arguments: ['ready'] }),
    ).resolves.toEqual(RESULT);
    expect(guest.services).toBe(channel.services);
    expect(session.run).toHaveBeenCalledOnce();
  });

  it('should control runit services through the session on a Fly machine', async () => {
    const channel = guestOf(
      new Sprite('test', new SpritesClient('test-token')),
    );
    vi.spyOn(channel.services, 'list').mockImplementation(async () => {
      throw new Error('Provider services must not handle this guest');
    });
    vi.spyOn(
      registry.providers['fly-machine'],
      'openGuest',
    ).mockImplementationOnce(async () => channel);
    const connection = new SetupConnection(
      registry.providers['fly-machine'],
      WORKSTATION,
    );

    const guest = await connection.guest();
    const session = await connection.open();

    expect(guest.services).not.toBe(channel.services);
    await expect(guest.services.list()).resolves.toEqual([]);
    expect(session.run).toHaveBeenCalledOnce();
  });
});
