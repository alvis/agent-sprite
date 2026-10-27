import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import '../../fixtures/output/styling';

import { prepareResult, writePreparedResult } from '#cli/output';
import { rememberSecret } from '#kernel/redaction';

import { CORPUS, CORPUS_SECRETS } from '../../fixtures/output/corpus';

import type { CommandResult, CommandSuccess } from '#application/result';
import type { PreparedResult } from '#cli/output';

import type { CorpusCase } from '../../fixtures/output/corpus';

type Variant = 'json' | 'human-pipe' | 'tsv' | 'tty-80' | 'tty-120';

/** one corpus entry rendered one way */
interface OutputCase {
  name: string;
  variant: Variant;
  entry: CorpusCase;
}

/** the instant every relative-time rendering is measured from */
const FIXED_NOW = Date.parse('2026-10-09T00:12:00.000Z');

const CASES: OutputCase[] = CORPUS.flatMap((entry) =>
  variantsOf(entry).map((variant) => ({
    name: `${entry.name}.${variant}`,
    variant,
    entry,
  })),
);

for (const secret of CORPUS_SECRETS) {
  rememberSecret(secret);
}

describe('fn:prepareResult', () => {
  it.each(CASES)(
    'should render and emit $name through its supported output channel',
    ({ variant, entry }) => {
      const prepared = prepare(entry, variant);
      const output = captureWrites(prepared);

      expect(output).toEqual({
        stdout: prepared.channel === 'stdout' ? prepared.text : '',
        stderr:
          (prepared.channel === 'stderr' ? prepared.text : '') +
          (prepared.notes ?? ''),
      });
      for (const secret of CORPUS_SECRETS) {
        expect(`${output.stdout}${output.stderr}`).not.toContain(secret);
      }

      if (variant === 'json') {
        expectJsonOutput(entry, prepared);
      } else if (variant === 'tsv') {
        expectTsvOutput(entry, prepared);
      } else {
        expectHumanOutput(entry, prepared);
      }
    },
  );
});

/**
 * chooses how a case is rendered
 * @param entry corpus case
 * @returns json, the piped form, and both terminal widths
 */
function variantsOf(entry: CorpusCase): Variant[] {
  const { result } = entry;
  const piped = result.ok && result.command === 'list' ? 'tsv' : 'human-pipe';

  return ['json', piped, 'tty-80', 'tty-120'];
}

/**
 * renders one case through the real output preparation
 * @param entry corpus case
 * @param variant output controls and stream shape
 * @returns what would be written, and where
 */
function prepare(entry: CorpusCase, variant: Variant): PreparedResult {
  const columns = variant === 'tty-80' ? 80 : 120;
  const isTTY = variant.startsWith('tty');
  const streams = {
    stdout: Object.assign(new PassThrough(), isTTY ? { isTTY, columns } : {}),
    stderr: Object.assign(new PassThrough(), isTTY ? { isTTY, columns } : {}),
  };
  vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW });
  try {
    return prepareResult({
      result: entry.result,
      options: { ...entry.options, json: variant === 'json' },
      streams,
    });
  } finally {
    vi.useRealTimers();
    streams.stdout.destroy();
    streams.stderr.destroy();
  }
}

/**
 * records both streams after writing a prepared result
 * @param prepared output to emit
 * @returns text written to each channel
 */
function captureWrites(prepared: PreparedResult): {
  stdout: string;
  stderr: string;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const streams = { stdout, stderr };
  let output = '';
  let errorOutput = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  stderr.on('data', (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });
  try {
    writePreparedResult(prepared, streams);
  } finally {
    stdout.destroy();
    stderr.destroy();
  }

  return { stdout: output, stderr: errorOutput };
}

/**
 * checks the versioned one-line JSON envelope
 * @param entry input result
 * @param prepared rendered result
 */
function expectJsonOutput(entry: CorpusCase, prepared: PreparedResult): void {
  expect(prepared).toEqual({
    channel: 'stdout',
    notes: undefined,
    text: expect.stringMatching(/^[^\n]+\n$/u),
  });
  const output: unknown = JSON.parse(prepared.text);

  expect(output).toMatchObject({
    schemaVersion: 1,
    command: entry.result.command,
    ok: entry.result.ok,
    ...(!entry.result.ok && { error: { code: entry.result.error.code } }),
  });
  if (entry.result.ok) {
    expect(output).toMatchObject({ data: expect.any(Object) });
    expectSuccessJson(entry.result, output);
  } else {
    expectFailureJson(entry.result, output);
  }
}

/**
 * checks consumer-visible values inside a successful JSON result
 * @param result completed command result
 * @param output freshly parsed JSON output
 */
function expectSuccessJson(result: CommandSuccess, output: unknown): void {
  if ('machine' in result.data) {
    const { id, name, setup } = result.data.machine;

    expect(output).toMatchObject({ data: { machine: { id, name, setup } } });
  }
  switch (result.command) {
    case 'list':
      expectListJson(result.data, output);
      break;
    case 'create':
      expect(output).toMatchObject({
        data: {
          preflight: { checks: result.data.preflight.checks },
          readiness: {
            ready: result.data.readiness.ready,
            failures: result.data.readiness.failures,
          },
          pairing: { status: result.data.pairing.status },
        },
      });
      break;
    case 'doctor':
      expectReadinessJson(result.data.currentReadiness, output);
      break;
    case 'show':
      expectShowJson(result.data.inspection, output);
      break;
    case 'setup':
      expectSetupJson(result.data, output);
      break;
    case 'terminate':
      expect(output).toMatchObject({
        data: {
          workstation: result.data.workstation,
          network: { status: result.data.network.status },
        },
      });
      break;
    default:
      break;
  }
}

/**
 * checks list identity, state, and provider failure facts
 * @param data completed list data
 * @param output freshly parsed JSON output
 */
function expectListJson(
  data: Extract<CommandSuccess, { command: 'list' }>['data'],
  output: unknown,
): void {
  expect(output).toMatchObject({
    data: {
      machines: data.machines.map(({ id, name, state, setup, provider }) => ({
        id,
        name,
        state,
        setup,
        provider,
      })),
      unavailable: data.unavailable.map(({ provider, code, reason }) => ({
        provider,
        code,
        reason,
      })),
    },
  });
}

/**
 * checks readiness values and sparse-array JSON behavior
 * @param readiness observed readiness
 * @param output freshly parsed JSON output
 */
function expectReadinessJson(
  readiness: Extract<
    CommandSuccess,
    { command: 'doctor' }
  >['data']['currentReadiness'],
  output: unknown,
): void {
  const { ready, failures, skipped, network } = readiness;

  expect(output).toMatchObject({
    data: {
      currentReadiness: {
        ready,
        failures,
        skipped: Array.from(
          { length: skipped.length },
          (_, index) => skipped.at(index) ?? null,
        ),
        network: { online: network.online, dnsReady: network.dnsReady },
      },
    },
  });
}

/**
 * checks requested guest inspection without pinning presentation wording
 * @param inspection requested guest observation
 * @param output freshly parsed JSON output
 */
function expectShowJson(
  inspection: Extract<
    CommandSuccess,
    { command: 'show' }
  >['data']['inspection'],
  output: unknown,
): void {
  if (inspection) {
    expect(output).toMatchObject({
      data: {
        inspection: {
          network: {
            online: inspection.network.online,
            dnsReady: inspection.network.dnsReady,
          },
          governor: { recorded: inspection.governor.recorded },
        },
      },
    });
  }
}

/**
 * checks section-specific setup outcomes through their public JSON fields
 * @param data completed setup data
 * @param output freshly parsed JSON output
 */
function expectSetupJson(
  data: Extract<CommandSuccess, { command: 'setup' }>['data'],
  output: unknown,
): void {
  if ('localCredential' in data) {
    expect(output).toMatchObject({
      data: {
        localCredential: {
          status: data.localCredential.status,
          scope: data.localCredential.scope,
          ...(data.localCredential.storage && {
            storage: data.localCredential.storage,
          }),
        },
      },
    });
  }
  if ('runtimeEnvironment' in data && data.runtimeEnvironment) {
    expect(output).toMatchObject({
      data: { runtimeEnvironment: { status: data.runtimeEnvironment.status } },
    });
  }
}

/**
 * checks failure code, recoverable identity, and retained observations
 * @param result failed command result
 * @param output freshly parsed JSON output
 */
function expectFailureJson(
  result: Extract<CommandResult, { ok: false }>,
  output: unknown,
): void {
  expect(output).toMatchObject({
    error: { code: result.error.code, message: expect.any(String) },
  });
  if (result.error.machine) {
    expect(output).toMatchObject({
      error: { machine: expectedIdentity(result.error.machine) },
    });
  }
  if (result.error.machineId) {
    expect(output).toMatchObject({
      error: { machineId: expectedIdentity(result.error.machineId) },
    });
  }
  if (result.error.details) {
    expect(output).toMatchObject({ error: { details: expect.any(Array) } });
  }
  if (result.data && 'recovery' in result.data) {
    expect(output).toMatchObject({ data: { recovery: result.data.recovery } });
  }
  if (result.command === 'doctor' && result.data) {
    expect(output).toMatchObject({
      data: {
        currentReadiness: {
          ready: result.data.currentReadiness.ready,
          failures: result.data.currentReadiness.failures,
        },
      },
    });
  }
}

/**
 * keeps plain identities exact and requires redaction for secret-bearing ones
 * @param value original identity
 */
function expectedIdentity(value: string): unknown {
  return containsSecret(value) ? expect.stringContaining('[REDACTED]') : value;
}

/**
 * checks exact ordinary TSV cells in column order, redacted secret cells, and notes
 * @param entry input result
 * @param prepared rendered result
 */
function expectTsvOutput(entry: CorpusCase, prepared: PreparedResult): void {
  if (!entry.result.ok || entry.result.command !== 'list') {
    throw new Error('TSV cases require a successful list result');
  }
  const { machines, unavailable } = entry.result.data;
  const rows = prepared.text === '' ? [] : prepared.text.trimEnd().split('\n');

  expect(prepared.channel).toBe('stdout');
  const expectedRows = machines.map((machine) =>
    [
      machine.name,
      machine.id,
      machine.state,
      machine.createdAt ?? '',
      machine.agentUrl ?? '',
      machine.setup,
      machine.organization,
      machine.provider,
    ].map((value) => {
      if (typeof value === 'string' && containsSecret(value)) {
        return expect.stringContaining('[REDACTED]');
      }

      return typeof value === 'string' && !containsControlCharacter(value)
        ? value
        : expect.any(String);
    }),
  );

  expect(rows.map((row) => row.split('\t'))).toEqual(expectedRows);
  expect(Boolean(prepared.notes)).toBe(
    unavailable.length > 0 ||
      machines.some(
        (machine) =>
          'newerRelease' in machine && typeof machine.newerRelease === 'string',
      ),
  );
  for (const provider of unavailable) {
    expect(prepared.notes).toContain(provider.provider);
  }
  expect(prepared.text).not.toContain('\r');
  expect(prepared.text).not.toContain('\u001b');
  expect(prepared.text).not.toContain('\u009b');
}

/**
 * checks the human channel and whether there is visible content
 * @param entry input result
 * @param prepared rendered result
 */
function expectHumanOutput(entry: CorpusCase, prepared: PreparedResult): void {
  expect(prepared).toEqual({
    channel: entry.result.ok ? 'stdout' : 'stderr',
    notes: undefined,
    text: expect.any(String),
  });
  const isEmptyList =
    entry.result.ok &&
    entry.result.command === 'list' &&
    entry.result.data.machines.length === 0 &&
    entry.result.data.unavailable.length === 0;

  if (isEmptyList) {
    expect(prepared.text.trim()).toBe('');
  } else {
    expect(prepared.text.trim().length).toBeGreaterThan(0);
  }
  if (!entry.result.ok) {
    expectHumanFailure(entry.result.error, prepared.text);
  }
}

/**
 * checks recoverable identity and setup status on the failure stream
 * @param error failed command error
 * @param text rendered failure stream
 */
function expectHumanFailure(
  error: Extract<CommandResult, { ok: false }>['error'],
  text: string,
): void {
  if (error.machine) {
    expect(text).toContain(
      containsSecret(error.machine) ? '[REDACTED]' : error.machine,
    );
  }
  if (error.machineId) {
    expect(text).toContain(
      containsSecret(error.machineId) ? '[REDACTED]' : error.machineId,
    );
  }
  if (error.setupIncomplete) {
    expect(text).toMatch(/setup.*incomplete/iu);
  }
}

/**
 * whether a field has delimiters or terminal controls requiring TSV escaping
 * @param value input field
 */
function containsControlCharacter(value: string): boolean {
  return ['\t', '\n', '\r', '\\', '\u001b', '\u009b'].some((character) =>
    value.includes(character),
  );
}

/**
 * whether an input field contains a registered secret
 * @param value input field
 */
function containsSecret(value: string): boolean {
  return CORPUS_SECRETS.some((secret) => value.includes(secret));
}
