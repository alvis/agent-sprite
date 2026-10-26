import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { debianFamily } from '#adapters/guest/os/debian/family';
import { ShellSession } from '#adapters/guest/platform/session/shell';
import { OperationContext, withOperation } from '#kernel/operation';
import { rememberSecret } from '#kernel/redaction';

import type {
  GuestExecResult,
  GuestProcess,
} from '#application/ports/guest-channel';
import type { OsRelease } from '#domain/guest';

vi.useFakeTimers();

const RELEASE: OsRelease = {
  family: 'debian',
  id: 'debian',
  versionId: '12',
  arch: 'x86_64',
  libc: 'glibc',
};

/** caller-controlled streaming shell that preserves the real script framing */
class ControlledShell extends EventEmitter implements GuestProcess {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly writes: string[] = [];
  public readonly scripts: Array<{ script: string; marker: string }> = [];
  public killed = false;

  /**
   * binds whether the provider shell honors an orderly input close
   * @param options fixed transport behavior for this shell instance
   * @param options.exitOnEnd whether ending stdin exits the shell
   */
  constructor({ exitOnEnd = true }: { readonly exitOnEnd?: boolean } = {}) {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      const script = chunk.toString();
      this.writes.push(script);
      const marker = /@@open-agent-status:[0-9a-f-]+:/u.exec(script)?.[0];
      if (marker) {
        this.scripts.push({ script, marker });
      }
    });
    this.stdin.on('finish', () => {
      if (exitOnEnd) {
        this.emit('exit', 0);
      }
    });
  }

  public reply(index: number, result: GuestExecResult): void {
    const marker = this.scripts[index]?.marker;
    if (!marker) {
      throw new Error(`No script at index ${index}`);
    }
    this.stdout.write(`${result.stdout}\n${marker}${result.exitCode}\n`);
    this.stderr.write(`${result.stderr}\n${marker}${result.exitCode}\n`);
  }

  public kill(): void {
    this.killed = true;
    this.emit('exit', 143);
  }
}

async function scriptAt(shell: ControlledShell, count: number): Promise<void> {
  await vi.waitFor(() => expect(shell.scripts).toHaveLength(count));
}

describe('cl:ShellSession', () => {
  it('should run framed commands, redact resolved secrets, and release its awake hold', async () => {
    const shell = new ControlledShell();
    const session = new ShellSession(shell, debianFamily);
    const secret = 'shell-session-secret-unique-20261026';
    rememberSecret(secret);

    expect(() => session.release).toThrowError('has not probed');
    expect(session.pid).toBe(0);
    session.start(RELEASE, 51);
    expect(session.release).toBe(RELEASE);
    expect(session.pid).toBe(51);

    const hold = {
      open: vi.fn((pid: number) => ({
        argv: ['hold', 'open', String(pid)] as const,
        timeoutMs: 50,
      })),
      close: vi.fn((pid: number) => ({
        argv: ['hold', 'close', String(pid)] as const,
        timeoutMs: 50,
      })),
    };
    const opening = session.holdAwake(hold);
    await scriptAt(shell, 1);
    expect(shell.scripts[0]?.script).toContain('hold');
    shell.reply(0, { stdout: '', stderr: '', exitCode: 0 });
    await opening;

    const running = session.run({ argv: ['/bin/true'], timeoutMs: 50 });
    await scriptAt(shell, 2);
    shell.reply(1, {
      stdout: `before ${secret} after`,
      stderr: `error ${secret}`,
      exitCode: 7,
    });
    await expect(running).resolves.toEqual({
      exitCode: 7,
      stdout: 'before [REDACTED] after',
      stderr: 'error [REDACTED]',
    });

    const closing = session[Symbol.asyncDispose]();
    await scriptAt(shell, 3);
    expect(shell.scripts[2]?.script).toContain('close');
    shell.reply(2, { stdout: '', stderr: '', exitCode: 0 });
    await closing;
    expect(hold.open).toHaveBeenCalledExactlyOnceWith(51);
    expect(hold.close).toHaveBeenCalledExactlyOnceWith(51);
    expect(shell.killed).toBe(false);
  });

  it('should serialize scripts and keep each framed result separate', async () => {
    const shell = new ControlledShell();
    const session = new ShellSession(shell, debianFamily);
    const first = session.script('first', 'first-marker:', 50);
    const second = session.script('second', 'second-marker:', 50);
    await vi.waitFor(() => expect(shell.writes).toEqual(['first']));

    shell.stdout.write('one\nfirst-marker:0\n');
    shell.stderr.write('first-error\nfirst-marker:0\n');
    await expect(first).resolves.toEqual({
      exitCode: 0,
      stdout: 'one',
      stderr: 'first-error',
    });
    await vi.waitFor(() => expect(shell.writes).toEqual(['first', 'second']));
    shell.stdout.write('two\nsecond-marker:4\n');
    shell.stderr.write('second-error\nsecond-marker:4\n');
    await expect(second).resolves.toEqual({
      exitCode: 4,
      stdout: 'two',
      stderr: 'second-error',
    });
    await session[Symbol.asyncDispose]();
  });

  it('should report startup diagnostics when the shell exits before any status', async () => {
    const shell = new ControlledShell();
    const session = new ShellSession(shell, debianFamily);
    const running = session.script('startup', 'startup-marker:', 50);
    shell.stderr.write('root shell denied');
    await Promise.resolve();
    shell.emit('exit', 127);

    await expect(running).rejects.toMatchObject({
      code: 'PREFLIGHT',
      message: expect.stringContaining('status 127'),
      details: ['root shell denied'],
    });
    await session[Symbol.asyncDispose]();
    expect(shell.killed).toBe(true);
  });

  it('should treat a later shell exit as a lost session', async () => {
    const shell = new ControlledShell();
    const session = new ShellSession(shell, debianFamily);
    const first = session.script('first', 'first-marker:', 50);
    await Promise.resolve();
    shell.stdout.write('\nfirst-marker:0\n');
    shell.stderr.write('\nfirst-marker:0\n');
    await first;
    const second = session.script('second', 'second-marker:', 50);
    await Promise.resolve();
    shell.emit('exit', 9);

    await expect(second).rejects.toThrowError(
      'exited with status 9 during the session',
    );
    await expect(
      session.script('third', 'third-marker:', 50),
    ).rejects.toThrowError('exited with status 9');
  });

  for (const [kind, message] of [
    ['stdin', 'The guest shell stopped reading'],
    ['connection', 'The connection to the guest shell broke'],
    ['mismatch', 'The guest reported two statuses for one command'],
    ['malformed', 'The guest wrote a malformed status line'],
  ] as const) {
    it(`should fail a pending script on ${kind} failure`, async () => {
      const shell = new ControlledShell();
      const session = new ShellSession(shell, debianFamily);
      const running = session.script('script', 'status-marker:', 50);
      await Promise.resolve();
      if (kind === 'stdin') {
        shell.stdin.emit('error', new Error('write failed'));
      } else if (kind === 'connection') {
        shell.emit('error', 'connection lost');
      } else if (kind === 'mismatch') {
        shell.stdout.write('\nstatus-marker:0\n');
        shell.stderr.write('\nstatus-marker:1\n');
      } else {
        shell.stdout.write('\nstatus-marker:nope\n');
      }

      await expect(running).rejects.toThrowError(message);
      await expect(
        session.script('later', 'later-marker:', 50),
      ).rejects.toThrowError(message);
      if (kind === 'mismatch' || kind === 'malformed') {
        expect(shell.killed).toBe(true);
      }
    });
  }

  it('should report a failed write callback when the provider cannot accept a script', async () => {
    const shell = new ControlledShell();
    const session = new ShellSession(shell, debianFamily);
    shell.stdin.destroy();

    await expect(
      session.script('script', 'status-marker:', 50),
    ).rejects.toThrowError('The guest shell stopped reading');
    expect(shell.writes).toHaveLength(0);
  });

  it('should cancel a pending command and kill the shell', async () => {
    const shell = new ControlledShell();
    const session = new ShellSession(shell, debianFamily);
    const controller = new AbortController();
    const operation = new OperationContext({ signal: controller.signal });
    const running = withOperation(operation, async () =>
      session.script('script', 'status-marker:', 50),
    );
    await Promise.resolve();
    controller.abort();

    await expect(running).rejects.toMatchObject({ action: 'cancel' });
    expect(shell.killed).toBe(true);
  });

  it('should kill a shell that never reports command completion', async () => {
    const shell = new ControlledShell();
    const session = new ShellSession(shell, debianFamily);
    const running = session.script('script', 'status-marker:', 0);
    const observed = running.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(observed).resolves.toMatchObject({
      message: 'The guest reported no status within 30000 ms',
    });
    expect(shell.killed).toBe(true);
  });

  it('should kill a shell that ignores an orderly close', async () => {
    const shell = new ControlledShell({ exitOnEnd: false });
    const session = new ShellSession(shell, debianFamily);
    const closing = session[Symbol.asyncDispose]();
    await vi.advanceTimersByTimeAsync(10_000);
    await closing;
    expect(shell.killed).toBe(true);
  });

  it('should close even when the guest shell stops reading the awake-hold release', async () => {
    const shell = new ControlledShell();
    const session = new ShellSession(shell, debianFamily);
    session.start(RELEASE, 51);
    const opening = session.holdAwake({
      open: () => ({ argv: ['hold', 'open'], timeoutMs: 50 }),
      close: () => ({ argv: ['hold', 'close'], timeoutMs: 50 }),
    });
    await scriptAt(shell, 1);
    shell.reply(0, { stdout: '', stderr: '', exitCode: 0 });
    await opening;
    const closing = session[Symbol.asyncDispose]();
    await scriptAt(shell, 2);
    shell.stdin.emit('error', new Error('write stopped'));
    await closing;
    expect(shell.killed).toBe(false);
  });
});
