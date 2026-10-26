import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { inspectTailscale } from '#adapters/drivers/networks/tailscale/status';
import { parseTailnetStatus } from '#adapters/drivers/networks/tailscale/status-parser';
import { OperationContext, withOperation } from '#kernel/operation';
import { rememberSecret } from '#kernel/redaction';

import { createFilesystemSprite, guestOf } from '../../../../mocks/sprites';

import type { ExecResult, Sprite } from '@fly/sprites';

/**
 * runs real status and egress parsing against an isolated fake guest command boundary
 * @param outputs result or rejection for each executable the subject may run
 * @returns observed tailnet status and executed command names
 */
async function inspectWithCommands(
  outputs: Record<string, ExecResult | Error>,
) {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-tailscale-live-status-'),
  );
  const execute = vi.fn<Sprite['execFile']>(async (file, args = []) => {
    const command =
      file === '/usr/bin/sudo' ? args.slice(args.indexOf('--') + 1) : [file];
    const program = command[0];
    const output = program ? outputs[program] : undefined;
    if (!output) {
      throw new TypeError(`Unexpected guest command: ${program}`);
    }
    if (output instanceof Error) {
      throw output;
    }

    return output;
  });
  const sprite = createFilesystemSprite({ root: directory.path, execute });
  const status = await inspectTailscale(guestOf(sprite));
  const invocations = execute.mock.calls.map(([file, args = []]) =>
    file === '/usr/bin/sudo'
      ? args.slice(args.indexOf('--') + 1)
      : [file, ...args],
  );

  return {
    status,
    commands: invocations.map(([file]) => file),
    invocations,
  };
}

/**
 * makes a successful fake guest command response
 * @param stdout captured command output
 * @returns successful SDK result
 */
function succeeded(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

describe('fn:inspectTailscale unavailable status', () => {
  it('should use the generic offline reason when an operational error has no diagnostic', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailscale-empty-error-'),
    );
    const execute = vi
      .fn<Sprite['execFile']>()
      .mockRejectedValue(new Error(''));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    expect(await inspectTailscale(guestOf(sprite))).toStrictEqual({
      online: false,
      dnsReady: false,
      skipped: false,
      reason: 'Tailscale status unavailable',
    });
  });

  it.each([null, { message: 'untrusted SDK detail' }])(
    'should use a generic offline reason for a non-Error SDK rejection',
    async (rejection) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-tailscale-rejection-'),
      );
      const execute = vi.fn<Sprite['execFile']>().mockRejectedValue(rejection);
      const sprite = createFilesystemSprite({
        root: directory.path,
        execute,
      });

      const status = await inspectTailscale(guestOf(sprite));

      expect(status).toEqual({
        online: false,
        dnsReady: false,
        skipped: false,
        reason: 'Tailscale status unavailable',
      });
    },
  );

  it('should record nonzero and operational transport failures as bounded offline evidence', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailscale-offline-'),
    );
    const secret = 'cor02-private-tailnet-key';
    rememberSecret(secret);
    const execute = vi
      .fn<Sprite['execFile']>()
      .mockResolvedValueOnce({
        stdout: '',
        stderr: `unavailable ${secret} ${'x'.repeat(700)}`,
        exitCode: 7,
      })
      .mockRejectedValueOnce(new Error(`transport rejected ${secret}`));
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute,
    });

    for (const status of [
      await inspectTailscale(guestOf(sprite)),
      await inspectTailscale(guestOf(sprite)),
    ]) {
      expect(status).toMatchObject({
        online: false,
        dnsReady: false,
        skipped: false,
      });
      expect(status.reason).toBeTruthy();
      expect(status.reason!.length).toBeLessThanOrEqual(512);
      expect(status.reason).not.toContain(secret);
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('should reject malformed success and programmer faults instead of marking them offline', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailscale-invalid-'),
    );
    const execute = vi
      .fn<Sprite['execFile']>()
      .mockResolvedValueOnce({ stdout: '{', stderr: '', exitCode: 0 })
      .mockRejectedValueOnce(new TypeError('broken SDK response'));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    await expect(inspectTailscale(guestOf(sprite))).rejects.toBeInstanceOf(
      SyntaxError,
    );
    await expect(inspectTailscale(guestOf(sprite))).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('should preserve cancellation during a deferred SDK status probe', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailscale-cancel-'),
    );
    const pending = Promise.withResolvers<ExecResult>();
    const execute = vi
      .fn<Sprite['execFile']>()
      .mockReturnValue(pending.promise);
    const sprite = createFilesystemSprite({ root: directory.path, execute });
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    const result = withOperation(context, async () =>
      inspectTailscale(guestOf(sprite)),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort();

    await expect(result).rejects.toMatchObject({ action: 'cancel' });
    pending.resolve({ stdout: '{}', stderr: '', exitCode: 0 });
  });
});

describe('fn:parseTailnetStatus', () => {
  it('should combine online identity, selected exit peer, and live egress evidence', () => {
    const status = parseTailnetStatus(
      {
        Self: {
          ID: 'device-42',
          Online: true,
          TailscaleIPs: ['2001:db8::42', '192.0.2.42/32'],
        },
        ExitNodeStatus: {
          ID: 'exit-7',
          TailscaleIPs: ['2001:db8::7', '198.51.100.7/32'],
        },
        Peer: {
          other: { ID: 'other', DNSName: 'other.example.test.' },
          selected: { ID: 'exit-7', DNSName: 'exit.example.test.' },
        },
      },
      {
        routeDevice: 'tailscale0',
        dnsReady: true,
        egressIp: '203.0.113.8',
      },
    );

    expect(status).toStrictEqual({
      deviceId: 'device-42',
      ip: '192.0.2.42/32',
      online: true,
      exitNode: 'exit-7',
      exitNodeIp: '198.51.100.7',
      exitNodeName: 'exit.example.test',
      skipped: false,
      routeDevice: 'tailscale0',
      dnsReady: true,
      egressIp: '203.0.113.8',
    });
  });

  it('should recover the selected exit address and host name from the peer when native exit details omit them', () => {
    const status = parseTailnetStatus(
      {
        Self: { ID: 'device-43', Online: false, TailscaleIPs: 'invalid' },
        ExitNodeStatus: { ID: 'exit-8' },
        Peer: {
          invalid: null,
          other: { ID: 'other', HostName: 'other-host' },
          selected: {
            ID: 'exit-8',
            TailscaleIPs: ['2001:db8::8', '198.51.100.8/32'],
            HostName: 'exit-host',
          },
        },
      },
      { dnsReady: false },
    );

    expect(status).toStrictEqual({
      deviceId: 'device-43',
      ip: undefined,
      online: false,
      exitNode: 'exit-8',
      exitNodeIp: '198.51.100.8',
      exitNodeName: 'exit-host',
      skipped: false,
      dnsReady: false,
    });
  });

  it('should leave absent or malformed native identity fields unknown', () => {
    const status = parseTailnetStatus(
      {
        Self: { ID: '', Online: 'true', TailscaleIPs: [7, '2001:db8::9'] },
        ExitNodeStatus: 'invalid',
        Peer: 'invalid',
      },
      { dnsReady: false },
    );

    expect(status).toStrictEqual({
      deviceId: undefined,
      ip: undefined,
      online: false,
      exitNode: undefined,
      exitNodeIp: undefined,
      exitNodeName: undefined,
      skipped: false,
      dnsReady: false,
    });
  });

  it('should leave missing self identity and an unnamed selected peer unknown', () => {
    const status = parseTailnetStatus(
      {
        Self: null,
        ExitNodeStatus: { ID: 'exit-without-address' },
        Peer: { selected: { ID: 'exit-without-address' } },
      },
      { dnsReady: false },
    );

    expect(status).toStrictEqual({
      deviceId: undefined,
      ip: undefined,
      online: false,
      exitNode: 'exit-without-address',
      exitNodeIp: undefined,
      exitNodeName: undefined,
      skipped: false,
      dnsReady: false,
    });
  });
});

describe('fn:inspectTailscale live status', () => {
  const selectedStatus = succeeded(
    JSON.stringify({
      Self: { ID: 'device-with-exit', Online: true },
      ExitNodeStatus: { ID: 'exit-20' },
    }),
  );

  it('should skip public egress commands when no exit node is selected', async () => {
    const { status, commands } = await inspectWithCommands({
      tailscale: succeeded(
        JSON.stringify({
          Self: {
            ID: 'device-without-exit',
            Online: true,
            TailscaleIPs: ['192.0.2.20/32'],
          },
        }),
      ),
    });

    expect(status).toStrictEqual({
      deviceId: 'device-without-exit',
      ip: '192.0.2.20/32',
      online: true,
      exitNode: undefined,
      exitNodeIp: undefined,
      exitNodeName: undefined,
      skipped: false,
      dnsReady: false,
    });
    expect(commands).toEqual(['tailscale']);
  });

  it('should observe DNS, a direct public address, and the route device for a selected exit node', async () => {
    const { status, commands, invocations } = await inspectWithCommands({
      'tailscale': succeeded(
        JSON.stringify({
          Self: { ID: 'device-with-exit', Online: true },
          ExitNodeStatus: { ID: 'exit-20' },
          Peer: {
            selected: {
              ID: 'exit-20',
              DNSName: 'exit.example.test.',
              TailscaleIPs: ['198.51.100.20/32'],
            },
          },
        }),
      ),
      '/usr/bin/getent': succeeded('203.0.113.20 STREAM api.ipify.org\n'),
      '/usr/bin/env': succeeded('198.51.100.25\n'),
      'ip': succeeded(
        '203.0.113.20 via 192.0.2.1 dev tailscale0 src 192.0.2.20\n',
      ),
    });

    expect(status).toStrictEqual({
      deviceId: 'device-with-exit',
      ip: undefined,
      online: true,
      exitNode: 'exit-20',
      exitNodeIp: '198.51.100.20',
      exitNodeName: 'exit.example.test',
      skipped: false,
      routeDevice: 'tailscale0',
      dnsReady: true,
      egressIp: '198.51.100.25',
    });
    expect(commands).toEqual([
      'tailscale',
      '/usr/bin/getent',
      '/usr/bin/env',
      'ip',
    ]);
    expect(invocations[1]).toEqual([
      '/usr/bin/getent',
      'ahostsv4',
      'api.ipify.org',
    ]);
    expect(invocations[2]).toEqual([
      '/usr/bin/env',
      '-u',
      'HTTPS_PROXY',
      '-u',
      'HTTP_PROXY',
      '-u',
      'ALL_PROXY',
      '/usr/bin/curl',
      '-4',
      '--fail',
      '--silent',
      '--show-error',
      '--max-time',
      '10',
      'https://api.ipify.org',
    ]);
    expect(invocations[3]).toEqual([
      'ip',
      '-4',
      'route',
      'get',
      '203.0.113.20',
    ]);
  });

  it('should keep DNS and route unknown when resolution fails, while rejecting a non-address egress result', async () => {
    const { status, commands } = await inspectWithCommands({
      'tailscale': selectedStatus,
      '/usr/bin/getent': new Error('DNS unavailable'),
      '/usr/bin/env': succeeded('not-an-address\n'),
    });

    expect(status).toStrictEqual({
      deviceId: 'device-with-exit',
      ip: undefined,
      online: true,
      exitNode: 'exit-20',
      exitNodeIp: undefined,
      exitNodeName: undefined,
      skipped: false,
      routeDevice: undefined,
      dnsReady: false,
      egressIp: undefined,
    });
    expect(commands).toEqual(['tailscale', '/usr/bin/getent', '/usr/bin/env']);
  });

  it('should not route an empty DNS answer or claim an egress address after a failed public probe', async () => {
    const { status, commands } = await inspectWithCommands({
      'tailscale': selectedStatus,
      '/usr/bin/getent': succeeded('  \n'),
      '/usr/bin/env': new Error('public probe unavailable'),
    });

    expect(status).toStrictEqual({
      deviceId: 'device-with-exit',
      ip: undefined,
      online: true,
      exitNode: 'exit-20',
      exitNodeIp: undefined,
      exitNodeName: undefined,
      skipped: false,
      routeDevice: undefined,
      dnsReady: false,
      egressIp: undefined,
    });
    expect(commands).toEqual(['tailscale', '/usr/bin/getent', '/usr/bin/env']);
  });

  it('should preserve resolved DNS and public egress when route lookup fails', async () => {
    const { status, commands } = await inspectWithCommands({
      'tailscale': selectedStatus,
      '/usr/bin/getent': succeeded('203.0.113.30 STREAM api.ipify.org\n'),
      '/usr/bin/env': succeeded('198.51.100.30\n'),
      'ip': new Error('route lookup unavailable'),
    });

    expect(status).toStrictEqual({
      deviceId: 'device-with-exit',
      ip: undefined,
      online: true,
      exitNode: 'exit-20',
      exitNodeIp: undefined,
      exitNodeName: undefined,
      skipped: false,
      routeDevice: undefined,
      dnsReady: true,
      egressIp: '198.51.100.30',
    });
    expect(commands).toEqual([
      'tailscale',
      '/usr/bin/getent',
      '/usr/bin/env',
      'ip',
    ]);
  });

  it.each(['null', '[]', '"status"'])(
    'should reject a valid JSON status with the wrong shape: %s',
    async (body) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-tailscale-status-shape-'),
      );
      const execute = vi
        .fn<Sprite['execFile']>()
        .mockResolvedValue(succeeded(body));
      const sprite = createFilesystemSprite({
        root: directory.path,
        execute,
      });

      await expect(inspectTailscale(guestOf(sprite))).rejects.toThrow();
      expect(execute).toHaveBeenCalledOnce();
    },
  );
});
