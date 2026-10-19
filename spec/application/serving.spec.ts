import { afterEach, describe, expect, it, vi } from 'vitest';

import { inspectUntilServing } from '#application/serving';

import type { GuestInspection } from '#domain/observations/inspection';

const MINUTE = 60_000;
const FULL_INSPECTION = { governor: {} } as unknown as GuestInspection;

afterEach(() => {
  vi.useRealTimers();
});

describe('fn:inspectUntilServing', () => {
  it('should poll only the environment check until the agent answers, then inspect fully once', async () => {
    vi.useFakeTimers();
    const probe = vi
      .fn<() => Promise<{ ok: boolean } | undefined>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ok: true });
    const inspect = vi
      .fn<() => Promise<GuestInspection>>()
      .mockResolvedValue(FULL_INSPECTION);

    const pending = inspectUntilServing(probe, inspect);
    await vi.advanceTimersByTimeAsync(MINUTE);
    const result = await pending;

    expect({
      probes: probe.mock.calls.length,
      inspections: inspect.mock.calls.length,
      result,
    }).toEqual({ probes: 3, inspections: 1, result: FULL_INSPECTION });
  });

  it('should give up polling once the wait is over and still inspect fully once', async () => {
    vi.useFakeTimers();
    const probe = vi
      .fn<() => Promise<{ ok: boolean } | undefined>>()
      .mockResolvedValue({ ok: false });
    const inspect = vi
      .fn<() => Promise<GuestInspection>>()
      .mockResolvedValue(FULL_INSPECTION);

    const pending = inspectUntilServing(probe, inspect);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    const result = await pending;

    expect({
      stopped: probe.mock.calls.length < 30,
      inspections: inspect.mock.calls.length,
      result,
    }).toEqual({ stopped: true, inspections: 1, result: FULL_INSPECTION });
  });

  it('should probe once when the agent already answers', async () => {
    const probe = vi
      .fn<() => Promise<{ ok: boolean } | undefined>>()
      .mockResolvedValue({ ok: true });
    const inspect = vi
      .fn<() => Promise<GuestInspection>>()
      .mockResolvedValue(FULL_INSPECTION);

    await inspectUntilServing(probe, inspect);

    expect({
      probes: probe.mock.calls.length,
      inspections: inspect.mock.calls.length,
    }).toEqual({ probes: 1, inspections: 1 });
  });
});
