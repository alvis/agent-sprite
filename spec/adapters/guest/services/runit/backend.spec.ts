import { describe, expect, it, vi } from 'vitest';

import { RunitServiceControl } from '#adapters/guest/services/runit/backend';

import type { GuestExecResult } from '#application/ports/guest-channel';
import type { ServiceDefinition } from '#domain/services';

const run = vi.fn<
  (
    argv: readonly [string, ...string[]],
    timeoutMs: number,
  ) => Promise<GuestExecResult>
>(async () => ({
  exitCode: 0,
  stdout: JSON.stringify([
    {
      name: 'agent',
      status: 'running',
      needs: ['base'],
      startedAt: '2026-10-31',
    },
    { name: 'base', status: 'stopped', needs: [] },
  ]),
  stderr: '',
}));
const control = new RunitServiceControl(run, '/bin/dash');
const service = {
  name: 'agent',
  command: '/bin/agent',
  arguments: [],
  account: 'root',
  needs: [],
} satisfies ServiceDefinition;

describe('cl:RunitServiceControl', () => {
  it('should parse a listing including dependent and stopped services', async () => {
    await expect(control.list()).resolves.toEqual([
      {
        name: 'agent',
        status: 'running',
        needs: ['base'],
        startedAt: '2026-10-31',
      },
      { name: 'base', status: 'stopped', needs: [] },
    ]);
  });

  it.each([
    {
      reason: 'failed process',
      result: { exitCode: 1, stdout: '', stderr: 'permission denied' },
      message: /permission denied/u,
    },
    {
      reason: 'failed process without stderr',
      result: { exitCode: 7, stdout: '', stderr: '' },
      message: /exit 7/u,
    },
    {
      reason: 'invalid envelope',
      result: { exitCode: 0, stdout: '{}', stderr: '' },
      message: /malformed/u,
    },
    {
      reason: 'invalid entry',
      result: {
        exitCode: 0,
        stdout:
          '[{"name":"agent","status":"running","needs":[],"startedAt":7}]',
        stderr: '',
      },
      message: /malformed/u,
    },
  ])(
    'should refuse an unsuccessful or malformed listing ($reason)',
    async ({ result, message }) => {
      run.mockResolvedValueOnce(result);
      await expect(control.list()).rejects.toThrow(message);
    },
  );

  it('should ensure and remove a service using the root library runner', async () => {
    await control.ensure(service);
    await control.remove(service.name);

    expect(run.mock.calls[0]?.[0][2]).toContain('oa_sv_ensure');
    expect(run.mock.calls[0]?.[0][2]).toContain(JSON.stringify(service));
    expect(run.mock.calls[1]?.[0][2]).toContain("'oa_sv_remove' 'agent'");
  });

  it.each([
    { stderr: 'permission denied', message: /permission denied/u },
    { stderr: '', message: /exit 7/u },
  ])(
    'should report a failed service mutation (%j)',
    async ({ stderr, message }) => {
      run.mockResolvedValueOnce({ exitCode: 7, stdout: '', stderr });
      await expect(control.remove(service.name)).rejects.toThrow(message);
    },
  );

  it('should report a clean stop and a stop that did not complete', async () => {
    await expect(control.stop(service.name)).resolves.toBe(true);
    run.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    await expect(control.stop(service.name)).resolves.toBe(false);
  });

  it('should refuse stopping an uninstalled service', async () => {
    run.mockResolvedValueOnce({ exitCode: 2, stdout: '', stderr: '' });
    await expect(control.stop('absent')).rejects.toThrow(/no service.*absent/u);
  });
});
