import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServiceLogStream, Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { CommandFault, commandError } from '#errors';
import {
  ensureGuestService,
  restartGuestService,
  runGuest,
  runGuestResult,
  withGuestTaskHold,
  writeGuestFile,
} from '#integrations/guest';
import { InteractionExit } from '#navigation';
import { OperationContext, withOperation } from '#operation';
import { rememberSecret } from '#utilities/redaction';

import { createFilesystemSprite } from '../mocks/sprites.js';

import type { ServiceWithState } from '@fly/sprites';

const tailscale = {
  name: 'tailscaled',
  cmd: '/usr/bin/sudo',
  args: ['-n', '-E', '--', '/usr/sbin/tailscaled', '--old-flag'],
  needs: [],
  state: { name: 'tailscaled', status: 'running' },
} satisfies ServiceWithState;
const dependent = {
  name: 't3-code',
  cmd: '/usr/bin/sudo',
  args: ['-n', '-E', '--', '/opt/agent-sprite/t3/start'],
  needs: ['tailscaled'],
  httpPort: 3000,
  state: { name: 't3-code', status: 'running' },
} satisfies ServiceWithState;

/**
 * creates a narrow SDK service boundary from observed registrations
 * @param services current provider service definitions
 * @returns Sprite with typed service operations and real SDK log streams
 */
function createServiceSprite(services: ServiceWithState[]): Sprite {
  return Object.assign(
    new Sprite('services', new SpritesClient('test-token')),
    {
      listServices: vi.fn<Sprite['listServices']>(async () => services),
      getService: vi.fn<Sprite['getService']>(async (name) => ({
        name,
        cmd: '/usr/bin/sudo',
        args: [],
        needs: [],
        state: { name, status: 'running' },
      })),
      stopService: vi.fn<Sprite['stopService']>(
        async () =>
          new ServiceLogStream(
            new Response('{"type":"complete","timestamp":0}\n'),
          ),
      ),
      deleteService: vi.fn<Sprite['deleteService']>(async () => undefined),
      createService: vi.fn<Sprite['createService']>(
        async () =>
          new ServiceLogStream(
            new Response('{"type":"complete","timestamp":0}\n'),
          ),
      ),
    } satisfies Partial<Sprite>,
  );
}

describe('fn:ensureGuestService', () => {
  it('should report a supervised error with its service identity and no event payload', async () => {
    const sprite = createServiceSprite([]);
    vi.mocked(sprite.createService).mockResolvedValueOnce(
      new ServiceLogStream(
        new Response(
          '{"type":"error","timestamp":0,"message":"private service output"}\n',
        ),
      ),
    );

    await expect(
      ensureGuestService(sprite, 't3-code', { cmd: '/opt/t3/start' }),
    ).rejects.toMatchObject({
      code: 'PROVIDER',
      message: 'Sprite service t3-code reported error',
    });
  });

  it('should remove managed dependent registrations before replacing a changed service and recreate them afterward', async () => {
    const sprite = createServiceSprite([tailscale, dependent]);

    await ensureGuestService(sprite, 'tailscaled', {
      cmd: '/usr/sbin/tailscaled',
      args: ['--new-flag'],
    });

    const stop = vi.mocked(sprite.stopService);
    const remove = vi.mocked(sprite.deleteService);
    const create = vi.mocked(sprite.createService);
    const mutations = [
      ...stop.mock.calls.map(([name], index) => ({
        order: stop.mock.invocationCallOrder[index]!,
        action: 'stop',
        name,
      })),
      ...remove.mock.calls.map(([name], index) => ({
        order: remove.mock.invocationCallOrder[index]!,
        action: 'delete',
        name,
      })),
      ...create.mock.calls.map(([name], index) => ({
        order: create.mock.invocationCallOrder[index]!,
        action: 'create',
        name,
      })),
    ]
      .sort((left, right) => left.order - right.order)
      .map(({ action, name }) => ({ action, name }));

    expect(mutations).toEqual([
      { action: 'stop', name: 't3-code' },
      { action: 'delete', name: 't3-code' },
      { action: 'stop', name: 'tailscaled' },
      { action: 'delete', name: 'tailscaled' },
      { action: 'create', name: 'tailscaled' },
      { action: 'create', name: 't3-code' },
    ]);
    expect(create.mock.calls).toEqual([
      [
        'tailscaled',
        {
          cmd: '/usr/bin/sudo',
          args: ['-n', '-E', '--', '/usr/sbin/tailscaled', '--new-flag'],
          needs: [],
        },
        '5s',
      ],
      ['t3-code', dependent, '5s'],
    ]);
  });

  it('should reconcile an unchanged service without stopping or deleting registrations', async () => {
    const sprite = createServiceSprite([tailscale, dependent]);

    await ensureGuestService(sprite, 'tailscaled', {
      cmd: '/usr/sbin/tailscaled',
      args: ['--old-flag'],
    });

    expect(sprite.stopService).not.toHaveBeenCalled();
    expect(sprite.deleteService).not.toHaveBeenCalled();
    expect(sprite.createService).toHaveBeenCalledExactlyOnceWith(
      'tailscaled',
      {
        cmd: '/usr/bin/sudo',
        args: ['-n', '-E', '--', '/usr/sbin/tailscaled', '--old-flag'],
        needs: [],
      },
      '5s',
    );
  });

  it('should restore a stopped managed dependent when replacement startup fails', async () => {
    const stopped = {
      ...dependent,
      state: { name: 't3-code', status: 'stopped' },
    } satisfies ServiceWithState;
    const idle = {
      name: tailscale.name,
      cmd: tailscale.cmd,
      args: tailscale.args,
      needs: tailscale.needs,
    } satisfies ServiceWithState;
    const sprite = createServiceSprite([idle, stopped]);
    vi.mocked(sprite.createService).mockImplementationOnce(
      async () =>
        new ServiceLogStream(
          new Response('{"type":"exit","timestamp":0,"exit_code":1}\n'),
        ),
    );

    await expect(
      ensureGuestService(sprite, 'tailscaled', {
        cmd: '/usr/sbin/tailscaled',
        args: ['--new-flag'],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'PROVIDER' }));

    expect(sprite.stopService).not.toHaveBeenCalled();
    expect(vi.mocked(sprite.deleteService).mock.calls).toEqual([
      ['t3-code'],
      ['tailscaled'],
    ]);
    expect(sprite.createService).toHaveBeenLastCalledWith(
      't3-code',
      stopped,
      '5s',
    );
  });

  it('should preserve a provider failure, its prior cause, and the actual dependent restoration error', async () => {
    const sprite = createServiceSprite([tailscale, dependent]);
    const prior = new Error('prior provider cause');
    const primary = new CommandFault({
      code: 'PROVIDER',
      message: 'replacement failed',
      cause: prior,
    });
    const restoration = new Error('dependent restore refused');
    vi.mocked(sprite.createService)
      .mockRejectedValueOnce(primary)
      .mockRejectedValueOnce(restoration);

    const failure: unknown = await ensureGuestService(sprite, 'tailscaled', {
      cmd: '/usr/sbin/tailscaled',
      args: ['--new-flag'],
    }).catch((error: unknown) => error);

    expect(failure).toBe(primary);
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toEqual([
      prior,
      restoration,
    ]);
    expect(
      vi.mocked(sprite.createService).mock.calls.map(([name]) => name),
    ).toEqual(['tailscaled', 't3-code']);
    expect(commandError(primary)).toMatchObject({
      code: 'PROVIDER',
      details: [
        expect.stringContaining('dependent restore refused'),
        expect.stringContaining('prior provider cause'),
      ],
    });
  });

  it('should fail honestly when dependent restoration alone fails after replacement succeeds', async () => {
    const sprite = createServiceSprite([tailscale, dependent]);
    const restoration = new Error('dependent restore failed after replacement');
    vi.mocked(sprite.createService)
      .mockResolvedValueOnce(
        new ServiceLogStream(
          new Response('{"type":"complete","timestamp":0}\n'),
        ),
      )
      .mockRejectedValueOnce(restoration);

    await expect(
      ensureGuestService(sprite, 'tailscaled', {
        cmd: '/usr/sbin/tailscaled',
        args: ['--new-flag'],
      }),
    ).rejects.toBe(restoration);
    expect(
      vi.mocked(sprite.createService).mock.calls.map(([name]) => name),
    ).toEqual(['tailscaled', 't3-code']);
  });

  it('should refuse unmanaged dependents before any service mutation', async () => {
    const unmanaged = {
      ...dependent,
      name: 'user-service',
    } satisfies ServiceWithState;
    const sprite = createServiceSprite([tailscale, dependent, unmanaged]);

    await expect(
      ensureGuestService(sprite, 'tailscaled', {
        cmd: '/usr/sbin/tailscaled',
        args: ['--new-flag'],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'CONFLICT' }));

    expect(sprite.stopService).not.toHaveBeenCalled();
    expect(sprite.deleteService).not.toHaveBeenCalled();
    expect(sprite.createService).not.toHaveBeenCalled();
  });
});

describe('fn:withGuestTaskHold recovery', () => {
  it('should retain a work failure when hold release succeeds', async () => {
    const sprite = new Sprite(
      'disposable',
      new SpritesClient('sdk-only-hold-token'),
    );
    const order: string[] = [];
    const primary = new CommandFault({
      code: 'PREFLIGHT',
      message: 'work failed',
    });
    vi.spyOn(sprite, 'execFile').mockImplementation(async (_file, args) => {
      order.push(args?.includes('release') ? 'release' : 'acquire');

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await expect(
      withGuestTaskHold(sprite, 'update', async () => {
        order.push('work');
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(order).toEqual(['acquire', 'work', 'release']);
    expect(commandError(primary)).toMatchObject({ code: 'PREFLIGHT' });
  });

  it('should keep the original failure and releases the hold when release also fails', async () => {
    const sprite = new Sprite(
      'disposable',
      new SpritesClient('sdk-only-hold-token'),
    );
    const order: string[] = [];
    const prior = new Error('prior work cause');
    const primary = new CommandFault({
      code: 'PREFLIGHT',
      message: 'work failed',
      cause: prior,
    });
    const release = new Error('hold release refused');
    vi.spyOn(sprite, 'execFile').mockImplementation(async (_file, args) => {
      const action = args?.includes('release') ? 'release' : 'acquire';
      order.push(action);
      if (action === 'release') {
        throw release;
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const failure: unknown = await withGuestTaskHold(
      sprite,
      'update',
      async () => {
        order.push('work');
        throw primary;
      },
    ).catch((error: unknown) => error);

    expect(order).toEqual(['acquire', 'work', 'release']);
    expect(failure).toBe(primary);
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toEqual([prior, release]);
    expect(commandError(primary).code).toBe('PREFLIGHT');
  });

  it('should report release-only failure after completed work', async () => {
    const sprite = new Sprite(
      'disposable',
      new SpritesClient('sdk-only-hold-token'),
    );
    const release = new Error('release after success failed');
    const order: string[] = [];
    vi.spyOn(sprite, 'execFile').mockImplementation(async (_file, args) => {
      const action = args?.includes('release') ? 'release' : 'acquire';
      order.push(action);
      if (action === 'release') {
        throw release;
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await expect(
      withGuestTaskHold(sprite, 'update', async () => {
        order.push('work');

        return 'completed';
      }),
    ).rejects.toBe(release);
    expect(order).toEqual(['acquire', 'work', 'release']);
  });

  it('should retain cancellation identity and code after failed release', async () => {
    const sprite = new Sprite(
      'disposable',
      new SpritesClient('sdk-only-hold-token'),
    );
    const cancelled = new InteractionExit('cancel');
    const release = new Error('release during cancellation failed');
    vi.spyOn(sprite, 'execFile').mockImplementation(async (_file, args) => {
      if (args?.includes('release')) {
        throw release;
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const failure: unknown = await withGuestTaskHold(
      sprite,
      'update',
      async () => {
        throw cancelled;
      },
    ).catch((error: unknown) => error);

    expect(failure).toBe(cancelled);
    expect((cancelled.cause as AggregateError).errors).toEqual([release]);
    expect(commandError(cancelled)).toMatchObject({ code: 'CANCELLED' });
  });
});

describe('fn:restartGuestService', () => {
  it('should report the supervised name and nonzero exit without exposing service output', async () => {
    const sprite = createServiceSprite([]);
    vi.spyOn(sprite, 'restartService').mockResolvedValue(
      new ServiceLogStream(
        new Response(
          '{"type":"exit","timestamp":0,"exit_code":17,"message":"private service output"}\n',
        ),
      ),
    );

    await expect(restartGuestService(sprite, 't3-code')).rejects.toMatchObject({
      code: 'PROVIDER',
      message: 'Sprite service t3-code reported exit (exit 17)',
    });
    expect(sprite.getService).not.toHaveBeenCalled();
  });
});

describe('fn:runGuest', () => {
  it('should report only the sanitized final stderr tail and semantic step on nonzero exit', async () => {
    const secret = 'saf06-test-secret-unique';
    rememberSecret(secret);
    const sprite = new Sprite(
      'diagnostics',
      new SpritesClient('sdk-only-token'),
    );
    const argvSecret = 'argv-private-unique';
    const envSecret = 'env-private-unique';
    const inputSecret = 'input-private-unique';
    const stderr = `old-diagnostic-${'x'.repeat(520)}\u001b[31m${secret}\u001b[0m\u0000final-marker`;
    const execute = vi.spyOn(sprite, 'execFileHTTP').mockResolvedValue({
      stdout: 'stdout-private-unique',
      stderr,
      exitCode: 23,
    });

    const failure = await runGuest(
      sprite,
      ['/opt/private-executable', argvSecret],
      {
        step: 'updater verification',
        env: { PRIVATE: envSecret },
        input: inputSecret,
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'PROVIDER' });
    const message = String((failure as Error).message);
    expect(message).toContain(
      'Guest updater verification exited with status 23',
    );
    expect(message).toContain('[REDACTED]');
    expect(message).toContain('final-marker');
    expect(message).not.toContain('old-diagnostic');
    for (const privateValue of [
      secret,
      argvSecret,
      envSecret,
      inputSecret,
      'stdout-private-unique',
      '/opt/private-executable',
    ]) {
      expect(message).not.toContain(privateValue);
    }
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('\u0000');
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('fn:writeGuestFile', () => {
  it('should reject home and noncanonical destinations before root SDK mutation', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-root-write-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });

    for (const path of [
      '/home',
      '/home/agent/settings.json',
      '/home/sprite/settings.json',
      '/opt/../home/agent/settings.json',
      'relative.json',
    ]) {
      await expect(
        writeGuestFile(sprite, { path, contents: 'private' }),
      ).rejects.toThrow(/home files must be changed as their owning account/);
    }
    expect(sprite.filesystem().writeFile).not.toHaveBeenCalled();
    expect(sprite.filesystem().chown).not.toHaveBeenCalled();
    expect(sprite.filesystem().rename).not.toHaveBeenCalled();
  });
});

describe('fn:runGuestResult cancellation', () => {
  it('should forward the originating signal and existing timeout to SDK exec and HTTP boundaries', async () => {
    const sprite = new Sprite(
      'disposable',
      new SpritesClient('sdk-only-exec-token'),
    );
    const exec = vi.spyOn(sprite, 'execFile').mockResolvedValue({
      stdout: 'regular',
      stderr: '',
      exitCode: 0,
    });
    const http = vi.spyOn(sprite, 'execFileHTTP').mockResolvedValue({
      stdout: 'http',
      stderr: '',
      exitCode: 0,
    });
    const context = new OperationContext({
      signal: new AbortController().signal,
    });

    const result = await withOperation(context, async () => {
      const regular = await runGuestResult(sprite, ['/bin/true'], {
        timeoutMs: 45_000,
      });
      const uploaded = await runGuestResult(sprite, ['/bin/cat'], {
        input: 'sample',
      });

      return { regular, uploaded };
    });

    expect(result.regular.stdout).toBe('regular');
    expect(result.uploaded.stdout).toBe('http');
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/sudo',
      ['-n', '-E', '--', '/bin/true'],
      expect.objectContaining({ signal: context.signal, timeout: 45_000 }),
    );
    expect(http).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/sudo',
      ['-n', '-E', '--', '/bin/cat'],
      expect.objectContaining({
        signal: context.signal,
        input: 'sample',
        timeout: 120_000,
      }),
    );
  });

  it('should start no SDK exec after the invocation is cancelled', async () => {
    const sprite = new Sprite(
      'disposable',
      new SpritesClient('sdk-only-abort-token'),
    );
    const exec = vi.spyOn(sprite, 'execFile');
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });

    await expect(
      withOperation(context, async () => {
        controller.abort();

        return runGuestResult(sprite, ['/bin/true']);
      }),
    ).rejects.toMatchObject({ action: 'cancel' });

    expect(exec).not.toHaveBeenCalled();
  });
});
