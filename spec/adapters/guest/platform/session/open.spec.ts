import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { debianFamily } from '#adapters/guest/os/debian/family';
import { openWorkstationSession } from '#adapters/guest/platform/session/open';
import { registry } from '#composition/registry';

import type { WorkstationSessionParams } from '#adapters/guest/platform/session/open';
import type { GuestProcess } from '#application/ports/guest-channel';
import type { WorkstationRecord } from '#domain/workstation';

interface Reply {
  stdout: string;
  status: number;
  stderr?: string;
}

const OS_REPORT =
  'release:ID=debian\nrelease:VERSION_ID="12"\narch:x86_64\nlibc:glibc';
const WORKSTATION = {
  id: 'machine-1',
  name: 'primary',
  organization: 'example',
  state: 'running',
  metadata: { setup: 'incomplete' },
} satisfies WorkstationRecord;

/** a streaming provider shell that answers the session's framed scripts */
class ReplyingShell extends EventEmitter implements GuestProcess {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly scripts: string[] = [];
  public isKilled = false;
  readonly #replies: Reply[];

  constructor(replies: Reply[]) {
    super();
    this.#replies = [...replies];
    this.stdin.on('data', (chunk: Buffer) => {
      const script = chunk.toString();
      const marker = /@@open-agent-status:[0-9a-f-]+:/u.exec(script)?.[0];
      if (!marker) {
        return;
      }
      this.scripts.push(script);
      const reply = this.#replies.shift();
      if (!reply) {
        throw new Error('The test shell received an unexpected script');
      }
      this.stdout.write(`${reply.stdout}\n${marker}${reply.status}\n`);
      this.stderr.write(`${reply.stderr ?? ''}\n${marker}${reply.status}\n`);
    });
    this.stdin.on('finish', () => {
      this.emit('exit', 0);
    });
  }

  public kill(): void {
    this.isKilled = true;
    this.emit('exit', 143);
  }
}

/**
 * provider seam that opens the replying root shell after boot
 * @param shell controlled root shell
 * @returns a provider with the declared images and controlled shell
 */
function providerFor(
  shell: ReplyingShell,
): WorkstationSessionParams['provider'] {
  return {
    images: registry.providers.sprite.images,
    awaitGuestReady: vi.fn(async () => undefined),
    openRootShell: vi.fn(async () => shell),
  };
}

const AWAKE_HOLD: WorkstationSessionParams['awakeHold'] = {
  open: (pid) => ({ argv: ['awake', 'open', String(pid)], timeoutMs: 1_000 }),
  close: (pid) => ({ argv: ['awake', 'close', String(pid)], timeoutMs: 1_000 }),
};

async function openWith(shell: ReplyingShell) {
  return openWorkstationSession({
    provider: providerFor(shell),
    workstation: WORKSTATION,
    family: debianFamily,
    awakeHold: AWAKE_HOLD,
  });
}

describe('fn:openWorkstationSession', () => {
  it('should probe the guest, open its session, run a command, and release the awake hold', async () => {
    const shell = new ReplyingShell([
      { stdout: OS_REPORT, status: 0 },
      { stdout: 'pid:51', status: 0 },
      { stdout: '', status: 0 },
      { stdout: 'ran', status: 0 },
      { stdout: '', status: 0 },
    ]);
    const provider = providerFor(shell);
    const session = await openWorkstationSession({
      provider,
      workstation: WORKSTATION,
      family: debianFamily,
      awakeHold: AWAKE_HOLD,
    });

    expect({ release: session.release, pid: session.pid }).toEqual({
      release: {
        family: 'debian',
        id: 'debian',
        versionId: '12',
        arch: 'x86_64',
        libc: 'glibc',
      },
      pid: 51,
    });
    await expect(
      session.run({ argv: ['/bin/true'], timeoutMs: 1_000 }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: 'ran',
      stderr: '',
    });
    await session[Symbol.asyncDispose]();
    expect(shell.isKilled).toBe(false);
    expect(vi.mocked(provider.openRootShell)).toHaveBeenCalledExactlyOnceWith(
      WORKSTATION,
      debianFamily.shell,
    );
  });

  it('should reject an unreadable OS release and close its shell', async () => {
    const shell = new ReplyingShell([{ stdout: '', status: 66 }]);

    await expect(openWith(shell)).rejects.toMatchObject({
      code: 'PREFLIGHT',
      message: 'The guest has no readable OS release (status 66)',
    });
    expect(shell.isKilled).toBe(true);
    expect(shell.scripts).toHaveLength(1);
  });

  it('should reject a guest outside the declared OS family before preparation', async () => {
    const shell = new ReplyingShell([
      {
        stdout:
          'release:ID=alpine\nrelease:VERSION_ID=3.20\narch:x86_64\nlibc:musl',
        status: 0,
      },
    ]);

    await expect(openWith(shell)).rejects.toMatchObject({
      code: 'PREFLIGHT',
      message: expect.stringContaining('not of the debian family'),
    });
    expect(shell.isKilled).toBe(true);
    expect(shell.scripts).toHaveLength(1);
  });

  for (const { name, reply, code, message, details } of [
    {
      name: 'missing commands',
      reply: { stdout: 'missing:flock\nother\nmissing:setsid', status: 69 },
      code: 'PREFLIGHT',
      message: 'The guest lacks commands a setup session needs',
      details: ['flock', 'setsid'],
    },
    {
      name: 'unusable shared memory',
      reply: { stdout: '', status: 72 },
      code: 'PREFLIGHT',
      message: 'The guest has no writable /dev/shm for setup secrets',
      details: [],
    },
    {
      name: 'busy setup lock',
      reply: { stdout: '', status: 75 },
      code: 'CONFLICT',
      message: expect.stringContaining('held the guest'),
      details: [],
    },
    {
      name: 'other preparation failure',
      reply: { stdout: 'pid:51', status: 78 },
      code: 'PROVIDER',
      message: 'The guest setup session could not start (status 78)',
      details: [],
    },
    {
      name: 'success status without a shell PID',
      reply: { stdout: 'opened', status: 0 },
      code: 'PROVIDER',
      message: 'The guest setup session could not start (status 0)',
      details: [],
    },
  ]) {
    it(`should close the shell after ${name}`, async () => {
      const shell = new ReplyingShell([
        { stdout: OS_REPORT, status: 0 },
        reply,
      ]);

      await expect(openWith(shell)).rejects.toMatchObject({
        code,
        message,
        details,
      });
      expect(shell.isKilled).toBe(true);
      expect(shell.scripts).toHaveLength(2);
    });
  }
});
