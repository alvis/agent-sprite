import { describe, expect, it, vi } from 'vitest';

import { FlySupervisedServices } from '#drivers/providers/fly-machine/services';

import type {
  GuestChannel,
  GuestCommand,
  GuestExecResult,
} from '#drivers/guest-channel';

const NODE = '/opt/open-agent/node/bin/node';
const CONTROL = '/opt/open-agent/guest/supervisor/control.js';

/**
 * builds a channel whose control entry prints the given answer, with the
 * supervised control bound to it
 * @param answer what the entry prints and its exit status
 * @returns the channel's service control and its recorded commands
 */
function channelAnswering(answer: Partial<GuestExecResult>): {
  services: FlySupervisedServices;
  exec: ReturnType<typeof vi.fn<GuestChannel['exec']>>;
} {
  const exec = vi.fn<GuestChannel['exec']>(async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...answer,
  }));
  const channel: GuestChannel = {
    get services() {
      return services;
    },
    exec,
    spawn: vi.fn<GuestChannel['spawn']>(),
    exists: vi.fn<GuestChannel['exists']>(),
    read: vi.fn<GuestChannel['read']>(),
    assertUnrestrictedNetwork:
      vi.fn<GuestChannel['assertUnrestrictedNetwork']>(),
  };
  const services = new FlySupervisedServices(channel);

  return { services, exec };
}

/**
 * runs one request through a supervised control bound to a channel
 * @param answer what the control entry prints
 * @param request the request to make
 * @returns the outcome and the command the guest ran
 */
async function requestWith<T>(
  answer: Partial<GuestExecResult>,
  request: (services: FlySupervisedServices) => Promise<T>,
): Promise<{ outcome: T | Error; command: GuestCommand | undefined }> {
  const { services, exec } = channelAnswering(answer);
  const outcome = await request(services).catch(
    (error: unknown) => error as Error,
  );

  return { outcome, command: exec.mock.calls[0]?.[0] };
}

describe('cl:FlySupervisedServices', () => {
  it('should list the supervisor services through a short root control request', async () => {
    const { outcome, command } = await requestWith(
      {
        stdout: `${JSON.stringify({
          ok: true,
          services: [
            {
              name: 't3-code',
              status: 'running',
              needs: [],
              startedAt: '2026-10-14T00:00:00.000Z',
            },
            { name: 'open-agent-timer', status: 'running', needs: [] },
          ],
        })}\n`,
      },
      async (services) => services.list(),
    );

    expect({ outcome, command }).toEqual({
      outcome: [
        {
          name: 't3-code',
          status: 'running',
          needs: [],
          startedAt: '2026-10-14T00:00:00.000Z',
        },
        { name: 'open-agent-timer', status: 'running', needs: [] },
      ],
      command: {
        program: NODE,
        arguments: [CONTROL, 'list'],
        timeoutMs: 30_000,
      },
    });
  });

  it('should send an ensured definition on standard input', async () => {
    const { outcome, command } = await requestWith(
      { stdout: '{"ok":true}\n' },
      async (services) =>
        services.ensure({
          name: 't3-code',
          command: NODE,
          arguments: ['/opt/open-agent/drivers/agents/t3/guest/t3-launcher.js'],
          account: 'agent',
          needs: ['tailscaled'],
          httpPort: 3773,
        }),
    );

    expect({ outcome, command }).toEqual({
      outcome: undefined,
      command: {
        program: NODE,
        arguments: [CONTROL, 'ensure'],
        input: JSON.stringify({
          name: 't3-code',
          command: NODE,
          arguments: ['/opt/open-agent/drivers/agents/t3/guest/t3-launcher.js'],
          account: 'agent',
          needs: ['tailscaled'],
          httpPort: 3773,
        }),
        timeoutMs: 150_000,
      },
    });
  });

  it('should report whether a stopped service stopped', async () => {
    const { outcome, command } = await requestWith(
      { stdout: '{"ok":true,"stopped":false}\n' },
      async (services) => services.stop('tailscaled'),
    );

    expect({ outcome, command }).toEqual({
      outcome: false,
      command: {
        program: NODE,
        arguments: [CONTROL, 'stop', 'tailscaled'],
        timeoutMs: 45_000,
      },
    });
  });

  it.each([
    ['conflict', 'conflict'],
    ['not-found', 'not-found'],
    ['invalid', 'failed'],
    ['unavailable', 'failed'],
    ['failed', 'failed'],
  ])(
    'should raise a %s refusal as a %s provider fault',
    async (refusal, code) => {
      const { outcome } = await requestWith(
        {
          exitCode: 1,
          stdout: `${JSON.stringify({ ok: false, code: refusal, error: 'refused' })}\n`,
        },
        async (services) => services.remove('tailscaled'),
      );

      expect(outcome).toEqual(
        expect.objectContaining({
          name: 'ProviderFault',
          code,
          message: 'refused',
        }),
      );
    },
  );

  it('should name the guest diagnostic when the control entry gives no answer', async () => {
    const { outcome } = await requestWith(
      { exitCode: 127, stderr: 'node: not found\n' },
      async (services) => services.list(),
    );

    expect(outcome).toEqual(
      expect.objectContaining({
        name: 'ProviderFault',
        code: 'failed',
        message:
          "The guest supervisor's list request exited 127 without an answer: node: not found",
      }),
    );
  });
});
