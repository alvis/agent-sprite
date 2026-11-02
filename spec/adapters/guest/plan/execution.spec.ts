import { describe, expect, it, vi } from 'vitest';

import { runPlan } from '#adapters/guest/plan/execution';
import { SessionTransportFault } from '#adapters/guest/platform/session/faults';

import type { PlanProgress, SetupStep } from '#application/ports/plan';
import type { GuestSession } from '#application/ports/session';
import type { OsRelease } from '#domain/guest';

const RELEASE: OsRelease = {
  family: 'debian',
  id: 'debian',
  versionId: '12',
  arch: 'x86_64',
  libc: 'glibc',
};

const STEP = {
  id: 'prepare',
  component: 'guest',
  account: 'root',
  needs: [],
  apply: { argv: ['true'] },
  timeoutMs: 1000,
  critical: true,
  retry: 'transport',
} satisfies SetupStep;

describe('fn:runPlan', () => {
  it('should run dependencies before their dependants and report progress in execution order', async () => {
    const first = {
      ...STEP,
      id: 'first',
      apply: { argv: ['first'] },
    } satisfies SetupStep;
    const last = {
      ...STEP,
      id: 'last',
      needs: ['first'],
      apply: { argv: ['last'] },
    } satisfies SetupStep;
    const independent = {
      ...STEP,
      id: 'independent',
      apply: { argv: ['independent'] },
    } satisfies SetupStep;
    const commands: string[] = [];
    const progress: PlanProgress[] = [];
    const dispose = vi.fn(async () => undefined);
    const session = {
      release: RELEASE,
      pid: 1,
      run: async ({ argv }) => {
        commands.push(argv[0]);

        return { exitCode: 0, stdout: '', stderr: '' };
      },
      [Symbol.asyncDispose]: dispose,
    } satisfies GuestSession;

    const report = await runPlan({
      steps: [last, independent, first],
      openSession: async () => session,
      onProgress: (event) => progress.push(event),
    });

    expect(report).toEqual({
      isComplete: true,
      steps: [independent, first, last].map((step) => ({
        step,
        status: 'applied',
        attempts: 1,
      })),
    });
    expect(commands).toEqual(['independent', 'first', 'last']);
    expect(progress).toEqual(
      report.steps.flatMap((outcome) => [
        { kind: 'step-started', step: outcome.step, attempt: 1 },
        { kind: 'step-finished', outcome, durationMs: expect.any(Number) },
      ]),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([
    {
      invalid: [{ ...STEP }, { ...STEP }],
      issue: 'duplicate step identifiers',
    },
    {
      invalid: [{ ...STEP, needs: ['absent'] }],
      issue: 'an unknown dependency',
    },
    {
      invalid: [
        { ...STEP, id: 'first', needs: ['second'] },
        { ...STEP, id: 'second', needs: ['first'] },
      ],
      issue: 'a dependency cycle',
    },
    {
      invalid: [{ ...STEP }],
      settled: [STEP.id],
      issue: 'a step an earlier plan settled',
    },
  ])(
    'should reject $issue before opening a guest session',
    async ({ invalid, settled }) => {
      const openSession = vi.fn(async (): Promise<GuestSession> => {
        throw new Error('session should not open');
      });

      await expect(
        runPlan({ steps: invalid, settled, openSession }),
      ).rejects.toThrow(Error);
      expect(openSession).not.toHaveBeenCalled();
    },
  );

  it('should meet a need on a step an earlier plan settled without running it again', async () => {
    const tool = { ...STEP, id: 'tool', needs: ['foundation'] };
    const commands: string[] = [];
    const session = {
      release: RELEASE,
      pid: 1,
      run: async ({ argv }) => {
        commands.push(argv[0]);

        return { exitCode: 0, stdout: '', stderr: '' };
      },
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;

    const report = await runPlan({
      steps: [tool],
      settled: ['foundation'],
      openSession: async () => session,
    });

    expect(report).toEqual({
      isComplete: true,
      steps: [{ step: tool, status: 'applied', attempts: 1 }],
    });
    expect(commands).toEqual(['true']);
  });

  it('should report how long a finished step took', async () => {
    const progress: PlanProgress[] = [];
    const session = {
      release: RELEASE,
      pid: 1,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));

        return { exitCode: 0, stdout: '', stderr: '' };
      },
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;

    await runPlan({
      steps: [STEP],
      openSession: async () => session,
      onProgress: (event) => progress.push(event),
    });

    expect(progress.at(-1)).toEqual({
      kind: 'step-finished',
      outcome: { step: STEP, status: 'applied', attempts: 1 },
      durationMs: expect.toSatisfy((ms: number) => ms >= 25),
    });
  });

  it('should satisfy a step from its check and honor command-level defaults', async () => {
    const step = {
      ...STEP,
      check: { argv: ['check'], account: 'agent' as const, timeoutMs: 25 },
      verify: { argv: ['verify'] },
    } satisfies SetupStep;
    const commands: Array<Parameters<GuestSession['run']>[0]> = [];
    const session = {
      release: RELEASE,
      pid: 1,
      run: async (command) => {
        commands.push(command);

        return { exitCode: 0, stdout: '', stderr: '' };
      },
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;

    const report = await runPlan({
      steps: [step],
      openSession: async () => session,
    });

    expect(report).toEqual({
      isComplete: true,
      steps: [{ step, status: 'satisfied', attempts: 1 }],
    });
    expect(commands).toEqual([
      { argv: ['check'], account: 'agent', timeoutMs: 25 },
    ]);
  });

  it('should include failed apply standard error in its reason', async () => {
    const session = {
      release: RELEASE,
      pid: 1,
      run: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: '  permission denied  ',
      }),
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;

    const report = await runPlan({
      steps: [STEP],
      openSession: async () => session,
    });

    expect(report).toEqual({
      isComplete: false,
      steps: [
        {
          step: STEP,
          status: 'failed',
          attempts: 1,
          reason: expect.stringContaining('permission denied'),
        },
      ],
    });
  });

  it('should fail when verification exits nonzero after a missing check', async () => {
    const step = {
      ...STEP,
      check: { argv: ['check'] },
      verify: { argv: ['verify'] },
    } satisfies SetupStep;
    const commands: Array<Parameters<GuestSession['run']>[0]> = [];
    const session = {
      release: RELEASE,
      pid: 1,
      run: async (command) => {
        commands.push(command);

        return {
          exitCode: command.argv[0] === 'apply' ? 0 : 1,
          stdout: '',
          stderr: '',
        };
      },
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;
    const applying = {
      ...step,
      apply: { argv: ['apply'] },
    } satisfies SetupStep;

    const report = await runPlan({
      steps: [applying],
      openSession: async () => session,
    });

    expect(report).toEqual({
      isComplete: false,
      steps: [
        {
          step: applying,
          status: 'failed',
          attempts: 1,
          reason: expect.any(String),
        },
      ],
    });
    expect(commands).toEqual([
      { argv: ['check'], account: 'root', timeoutMs: 1000 },
      { argv: ['apply'], account: 'root', timeoutMs: 1000 },
      { argv: ['verify'], account: 'root', timeoutMs: 1000 },
    ]);
  });

  it('should apply a step when its missing check is followed by successful verification', async () => {
    const step = {
      ...STEP,
      check: { argv: ['check'] },
      verify: { argv: ['verify'] },
    } satisfies SetupStep;
    const commands: string[] = [];
    const session = {
      release: RELEASE,
      pid: 1,
      run: async ({ argv }) => {
        commands.push(argv[0]);

        return {
          exitCode: argv[0] === 'check' ? 1 : 0,
          stdout: '',
          stderr: '',
        };
      },
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;

    const report = await runPlan({
      steps: [step],
      openSession: async () => session,
    });

    expect(report).toEqual({
      isComplete: true,
      steps: [{ step, status: 'applied', attempts: 1 }],
    });
    expect(commands).toEqual(['check', 'true', 'verify']);
  });

  it('should skip an optional failure dependent while continuing independent steps', async () => {
    const optional = {
      ...STEP,
      id: 'optional',
      critical: false,
      apply: { argv: ['fail'] },
    } satisfies SetupStep;
    const dependent = { ...STEP, id: 'dependent', needs: ['optional'] };
    const independent = { ...STEP, id: 'independent' };
    const commands: string[] = [];
    const session = {
      release: RELEASE,
      pid: 1,
      run: async ({ argv }) => {
        commands.push(argv[0]);

        return {
          exitCode: argv[0] === 'fail' ? 1 : 0,
          stdout: '',
          stderr: '',
        };
      },
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;

    const report = await runPlan({
      steps: [optional, dependent, independent],
      openSession: async () => session,
    });

    expect(report).toEqual({
      isComplete: true,
      steps: [
        {
          step: optional,
          status: 'failed',
          attempts: 1,
          reason: expect.any(String),
        },
        {
          step: dependent,
          status: 'skipped',
          attempts: 0,
          reason: expect.stringContaining('optional'),
        },
        { step: independent, status: 'applied', attempts: 1 },
      ],
    });
    expect(commands).toEqual(['fail', 'true']);
  });

  it('should stop later independent work after a critical step fails', async () => {
    const later = { ...STEP, id: 'later' };
    const session = {
      release: RELEASE,
      pid: 1,
      run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;

    const report = await runPlan({
      steps: [STEP, later],
      openSession: async () => session,
    });

    expect(report).toEqual({
      isComplete: false,
      steps: [
        {
          step: STEP,
          status: 'failed',
          attempts: 1,
          reason: expect.any(String),
        },
        {
          step: later,
          status: 'skipped',
          attempts: 0,
          reason: expect.any(String),
        },
      ],
    });
  });

  it('should replace a transport-lost session and retry the step', async () => {
    const transportFailure = new SessionTransportFault('transport lost');
    const lostSession = {
      release: RELEASE,
      pid: 43,
      run: async () => {
        throw transportFailure;
      },
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;
    const replacement = {
      release: RELEASE,
      pid: 44,
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;
    const openSession = vi.fn(async (supersedes?: number) =>
      supersedes === lostSession.pid ? replacement : lostSession,
    );

    const report = await runPlan({ steps: [STEP], openSession });

    expect(report).toEqual({
      isComplete: true,
      steps: [{ step: STEP, status: 'applied', attempts: 2 }],
    });
    expect(openSession.mock.calls).toEqual([[undefined], [lostSession.pid]]);
  });

  it('should propagate a nontransport command error and close its session', async () => {
    const error = new Error('command failed');
    const dispose = vi.fn(async () => undefined);
    const session = {
      release: RELEASE,
      pid: 1,
      run: async () => {
        throw error;
      },
      [Symbol.asyncDispose]: dispose,
    } satisfies GuestSession;

    await expect(
      runPlan({ steps: [STEP], openSession: async () => session }),
    ).rejects.toBe(error);
    expect(dispose.mock.calls).toEqual([[]]);
  });

  it('should fail a never-retry step after its first transport fault', async () => {
    const step = { ...STEP, retry: 'never' as const };
    const fault = new SessionTransportFault('transport lost');
    const session = {
      release: RELEASE,
      pid: 1,
      run: async () => {
        throw fault;
      },
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies GuestSession;
    const openSession = vi.fn(async () => session);

    const report = await runPlan({ steps: [step], openSession });

    expect(report).toEqual({
      isComplete: false,
      steps: [{ step, status: 'failed', attempts: 1, reason: fault.message }],
    });
    expect(openSession.mock.calls).toEqual([[undefined]]);
  });

  it('should exhaust its attempt limit when opening replacement sessions keeps failing', async () => {
    const fault = new SessionTransportFault('session unavailable');
    const openSession = vi.fn(async (): Promise<GuestSession> => {
      throw fault;
    });
    const progress: PlanProgress[] = [];

    const report = await runPlan({
      steps: [STEP],
      openSession,
      attempts: 2,
      onProgress: (event) => progress.push(event),
    });

    expect(report).toEqual({
      isComplete: false,
      steps: [
        { step: STEP, status: 'failed', attempts: 2, reason: fault.message },
      ],
    });
    expect(openSession.mock.calls).toEqual([[undefined], [undefined]]);
    expect(progress).toEqual([
      { kind: 'step-started', step: STEP, attempt: 1 },
      {
        kind: 'step-retrying',
        step: STEP,
        attempt: 1,
        reason: fault.message,
      },
      { kind: 'step-started', step: STEP, attempt: 2 },
      {
        kind: 'step-finished',
        outcome: report.steps[0],
        durationMs: expect.any(Number),
      },
    ]);
  });
});
