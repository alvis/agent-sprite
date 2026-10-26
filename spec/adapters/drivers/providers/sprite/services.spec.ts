import { ServiceLogStream, Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { commandError } from '#application/failures';
import { CommandFault } from '#kernel/faults';

import { guestOf } from '../../../../mocks/sprites';

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
  args: ['-n', '-E', '--', '/opt/open-agent/t3/start'],
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

describe('mt:SpriteServiceControl.ensure', () => {
  it('should forward an HTTP port when registering a supervised service', async () => {
    const sprite = createServiceSprite([]);

    await guestOf(sprite).services.ensure({
      name: 'agent',
      command: '/opt/open-agent/start',
      arguments: [],
      account: 'root',
      needs: [],
      httpPort: 3773,
    });

    expect(sprite.createService).toHaveBeenCalledExactlyOnceWith(
      'agent',
      expect.objectContaining({ httpPort: 3773 }),
      '5s',
    );
  });

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
      guestOf(sprite).services.ensure({
        name: 't3-code',
        command: '/opt/t3/start',
        arguments: [],
        account: 'root',
        needs: [],
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER',
      message: 'Sprite service t3-code reported error',
    });
  });

  it('should remove managed dependent registrations before replacing a changed service and recreate them afterward', async () => {
    const sprite = createServiceSprite([tailscale, dependent]);

    await guestOf(sprite).services.ensure({
      name: 'tailscaled',
      command: '/usr/sbin/tailscaled',
      arguments: ['--new-flag'],
      account: 'root',
      needs: [],
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

    await guestOf(sprite).services.ensure({
      name: 'tailscaled',
      command: '/usr/sbin/tailscaled',
      arguments: ['--old-flag'],
      account: 'root',
      needs: [],
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
      guestOf(sprite).services.ensure({
        name: 'tailscaled',
        command: '/usr/sbin/tailscaled',
        arguments: ['--new-flag'],
        account: 'root',
        needs: [],
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

    const failure: unknown = await guestOf(sprite)
      .services.ensure({
        name: 'tailscaled',
        command: '/usr/sbin/tailscaled',
        arguments: ['--new-flag'],
        account: 'root',
        needs: [],
      })
      .catch((error: unknown) => error);

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
      guestOf(sprite).services.ensure({
        name: 'tailscaled',
        command: '/usr/sbin/tailscaled',
        arguments: ['--new-flag'],
        account: 'root',
        needs: [],
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
      guestOf(sprite).services.ensure({
        name: 'tailscaled',
        command: '/usr/sbin/tailscaled',
        arguments: ['--new-flag'],
        account: 'root',
        needs: [],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'CONFLICT' }));

    expect(sprite.stopService).not.toHaveBeenCalled();
    expect(sprite.deleteService).not.toHaveBeenCalled();
    expect(sprite.createService).not.toHaveBeenCalled();
  });
});

describe('mt:SpriteServiceControl.stop', () => {
  it('should report a clean stop', async () => {
    const sprite = createServiceSprite([tailscale]);

    const result = await guestOf(sprite).services.stop('tailscaled');

    expect(result).toBe(true);
    expect(sprite.stopService).toHaveBeenCalledWith('tailscaled', '15s');
  });

  it('should report a stop failure the service emits instead of throwing', async () => {
    const sprite = createServiceSprite([tailscale]);
    vi.mocked(sprite.stopService).mockResolvedValueOnce(
      new ServiceLogStream(
        new Response(
          '{"type":"error","timestamp":0,"message":"private stop output"}\n',
        ),
      ),
    );

    const result = await guestOf(sprite).services.stop('tailscaled');

    expect(result).toBe(false);
  });
});
