import { describe, expect, it, vi } from 'vitest';

import { FlyApi } from '#adapters/drivers/providers/fly-machine/api';
import {
  flyBootHookStep,
  inspectFlyBoot,
  startAndBoot,
  waitForBoot,
} from '#adapters/drivers/providers/fly-machine/boot';

import type { FlyMachineTarget } from '#adapters/drivers/providers/fly-machine/api';
import type { GuestChannel } from '#application/ports/guest-channel';

const TARGET: FlyMachineTarget = { app: 'alpha', machine: 'machine-1' };
const READY = { exit_code: 0, stdout: 'boot-1 ok\nboot-1\n', stderr: '' };

interface Request {
  method: string;
  path: string;
  body: unknown;
}

/**
 * supplies Machines API replies in order at the real HTTP boundary
 * @param replies responses to return in request order
 * @returns requests observed at the boundary
 */
function useApi(replies: readonly Response[]): Request[] {
  const remaining = [...replies];
  const seen: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(
        input instanceof globalThis.Request ? input.url : input,
      );

      seen.push({
        method: init?.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        body:
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as unknown)
            : undefined,
      });

      return (
        remaining.shift() ?? response({ error: 'unexpected request' }, 400)
      );
    }),
  );

  return seen;
}

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function guestWithOutput(stdout: string): GuestChannel {
  return {
    exec: vi.fn(async () => ({ exitCode: 0, stdout, stderr: '' })),
    spawn: vi.fn(() => {
      throw new Error('unexpected stream');
    }),
    exists: vi.fn(async () => false),
    read: vi.fn(async () => ''),
    assertUnrestrictedNetwork: vi.fn(async () => undefined),
    services: {
      list: vi.fn(async () => []),
      ensure: vi.fn(async () => undefined),
      stop: vi.fn(async () => true),
      remove: vi.fn(async () => undefined),
    },
  };
}

vi.useFakeTimers();

describe('Fly machine boot', () => {
  it.each([
    {
      scenario: 'already started',
      state: 'started',
      replies: [response(READY)],
      paths: ['/exec'],
    },
    {
      scenario: 'starting',
      state: 'starting',
      replies: [response({}), response(READY)],
      paths: ['/wait', '/exec'],
    },
    {
      scenario: 'stopped',
      state: 'stopped',
      replies: [response(undefined, 204), response({}), response(READY)],
      paths: ['/start', '/wait', '/exec'],
    },
    {
      scenario: 'conflicting start',
      state: 'stopped',
      replies: [
        response({ error: 'already starting' }, 409),
        response({}),
        response(READY),
      ],
      paths: ['/start', '/wait', '/exec'],
    },
  ])(
    'should start and wait for a $scenario machine as needed',
    async ({ state, replies, paths }) => {
      const seen = useApi(replies);

      await expect(
        startAndBoot(new FlyApi('token'), TARGET, { state }),
      ).resolves.toBeUndefined();

      expect(
        seen.map(({ path }) => path.replace(/\?.*/u, '').split('/').at(-1)),
      ).toEqual(paths.map((path) => path.slice(1)));
      expect(seen.at(-1)).toEqual({
        method: 'POST',
        path: '/v1/apps/alpha/machines/machine-1/exec',
        body: {
          command: [
            '/bin/cat',
            '/run/open-agent/boot-ready',
            '/proc/sys/kernel/random/boot_id',
          ],
          timeout: 10,
        },
      });
    },
  );

  it('should preserve a start failure instead of probing boot', async () => {
    const seen = useApi([response({ error: 'invalid machine' }, 400)]);

    await expect(
      startAndBoot(new FlyApi('token'), TARGET, { state: 'stopped' }),
    ).rejects.toMatchObject({ code: 'failed' });
    expect(seen.map(({ path }) => path)).toEqual([
      '/v1/apps/alpha/machines/machine-1/start',
    ]);
  });

  it.each(['ok', 'resumed', 'halted'])(
    'should accept a current %s boot',
    async (status) => {
      const seen = useApi([
        response({ exit_code: 0, stdout: `boot-1 ${status}\nboot-1\n` }),
      ]);

      await expect(
        waitForBoot(new FlyApi('token'), TARGET),
      ).resolves.toBeUndefined();

      expect(seen).toHaveLength(1);
    },
  );

  it.each([
    { name: 'missing ready file', result: { exit_code: 1, stdout: '' } },
    {
      name: 'stale boot ID',
      result: { exit_code: 0, stdout: 'old ok\nboot-1\n' },
    },
    { name: 'missing boot ID', result: { exit_code: 0, stdout: 'boot-1 ok' } },
    {
      name: 'absent exit code and ready text',
      result: { stdout: '\nboot-1\n' },
    },
  ])('should not accept a $name', async ({ result }) => {
    useApi([response(result)]);

    const timedOut = expect(
      waitForBoot(new FlyApi('token'), TARGET),
    ).rejects.toMatchObject({ code: 'transient' });
    await vi.advanceTimersByTimeAsync(180_000);
    await timedOut;
  });

  it.each(['failed', 'unrecognized', ''])(
    'should reject a current %s boot as failed',
    async (status) => {
      useApi([
        response({ exit_code: 0, stdout: `boot-1 ${status}\nboot-1\n` }),
      ]);

      await expect(
        waitForBoot(new FlyApi('token'), TARGET),
      ).rejects.toMatchObject({ code: 'failed' });
    },
  );

  it('should keep waiting after a recoverable probe failure', async () => {
    const seen = useApi([
      response({ error: 'guest unavailable' }, 400),
      response(READY),
    ]);

    const boot = waitForBoot(new FlyApi('token'), TARGET);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(boot).resolves.toBeUndefined();
    expect(seen.map(({ path }) => path)).toEqual([
      '/v1/apps/alpha/machines/machine-1/exec',
      '/v1/apps/alpha/machines/machine-1/exec',
    ]);
  });

  it('should preserve an authentication refusal from the boot probe', async () => {
    useApi([response({ error: 'token refused' }, 401)]);

    await expect(
      waitForBoot(new FlyApi('token'), TARGET),
    ).rejects.toMatchObject({ code: 'authentication' });
  });

  it('should read the last boot result, unsuccessful steps, and only boot-owned log lines', async () => {
    const status = {
      status: 'halted',
      startedAt: '2026-10-26T10:00:00Z',
      durationMs: 1200,
      steps: {
        mounted: { outcome: 'ok' },
        account: { outcome: 'failed' },
        packages: { outcome: 'skipped' },
        invalid: { outcome: 2 },
        absent: null,
      },
    };
    const guest = guestWithOutput(
      `${JSON.stringify(status)}\n--- open-agent boot log ---\nopen-agent-boot mounted\npackage secret\nopen-agent-boot account failed\n`,
    );

    const report = await inspectFlyBoot(guest);

    expect(report).toEqual({
      status: 'halted',
      startedAt: '2026-10-26T10:00:00Z',
      durationMs: 1200,
      unsuccessfulSteps: { account: 'failed', packages: 'skipped' },
      log: ['mounted', 'account failed'],
    });
    expect(guest.exec).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/bin/sh', timeoutMs: 30_000 }),
    );
  });

  it.each([
    {
      name: 'missing separator',
      output: '{"status":"ok"}',
      expected: { unsuccessfulSteps: {}, log: [] },
    },
    {
      name: 'invalid JSON',
      output: 'not JSON\n--- open-agent boot log ---\nopen-agent-boot retry',
      expected: { unsuccessfulSteps: {}, log: ['retry'] },
    },
    {
      name: 'JSON array',
      output: '[]\n--- open-agent boot log ---\n',
      expected: { unsuccessfulSteps: {}, log: [] },
    },
    {
      name: 'JSON null',
      output: 'null\n--- open-agent boot log ---\n',
      expected: { unsuccessfulSteps: {}, log: [] },
    },
  ])(
    'should report no recorded status for $name',
    async ({ output, expected }) => {
      expect(await inspectFlyBoot(guestWithOutput(output))).toEqual(expected);
    },
  );

  it.each(['ok', 'failed'])(
    'should report a recorded %s status',
    async (status) => {
      const output = `${JSON.stringify({ status, steps: 'invalid', startedAt: 2, durationMs: 'slow' })}\n--- open-agent boot log ---\n`;

      expect(await inspectFlyBoot(guestWithOutput(output))).toEqual({
        status,
        unsuccessfulSteps: {},
        log: [],
      });
    },
  );

  it('should ignore an unsupported recorded status and malformed optional fields', async () => {
    const output = `${JSON.stringify({ status: 'pending', steps: {}, startedAt: null, durationMs: null })}\n--- open-agent boot log ---\n`;

    expect(await inspectFlyBoot(guestWithOutput(output))).toEqual({
      unsuccessfulSteps: {},
      log: [],
    });
  });

  it('should build a critical root step that consumes the packaged hook in check, install, and verify', async () => {
    const step = await flyBootHookStep(['libraries']);
    const input = step.apply.input;

    expect(input).toEqual({ kind: 'text', value: expect.any(String) });
    expect(step).toEqual({
      id: 'boot-hook',
      component: 'boot-hook',
      account: 'root',
      needs: ['libraries'],
      check: {
        argv: [
          '/bin/sh',
          '-c',
          expect.stringContaining('cmp -s -'),
          'oa-boot-hook',
          expect.any(String),
        ],
        input,
      },
      apply: {
        argv: [
          '/bin/sh',
          '-c',
          expect.stringContaining('cat >'),
          'oa-boot-hook',
          expect.any(String),
          '700',
        ],
        input,
      },
      verify: {
        argv: [
          '/bin/sh',
          '-c',
          expect.stringContaining('cmp -s -'),
          'oa-boot-hook',
          expect.any(String),
        ],
        input,
      },
      timeoutMs: 900_000,
      critical: true,
      retry: 'transport',
    });
    expect(step.check?.argv.at(-1)).toBe(step.apply.argv.at(-2));
  });
});
