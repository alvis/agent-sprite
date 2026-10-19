import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { env } from 'node:process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import './fixtures/output/plain-output';

import { prepareResult } from '#cli/output';
import { rememberSecret } from '#kernel/redaction';

import { CORPUS, CORPUS_SECRETS } from './fixtures/output/corpus';

import type { PreparedResult } from '#cli/output';

import type { CorpusCase } from './fixtures/output/corpus';

type Variant = 'json' | 'human-pipe' | 'tsv' | 'tty-80' | 'tty-120';

/** one corpus entry rendered one way */
interface GoldenCase {
  name: string;
  variant: Variant;
  entry: CorpusCase;
}

const GOLDEN_DIRECTORY = fileURLToPath(
  new URL('fixtures/output/golden/', import.meta.url),
);
const IS_CAPTURE = env.OPEN_AGENT_CAPTURE_GOLDENS === '1';
/** the instant every relative-time rendering is measured from */
const FIXED_NOW = Date.parse('2026-10-09T00:12:00.000Z');

const CASES: GoldenCase[] = CORPUS.flatMap((entry) =>
  variantsOf(entry).map((variant) => ({
    name: `${entry.name}.${variant}`,
    variant,
    entry,
  })),
);

for (const secret of CORPUS_SECRETS) {
  rememberSecret(secret);
}
if (IS_CAPTURE) {
  rmSync(GOLDEN_DIRECTORY, { recursive: true, force: true });
  mkdirSync(GOLDEN_DIRECTORY, { recursive: true });
}

describe('fn:prepareResult', () => {
  it('should characterize every corpus case under a unique name', () => {
    const names = CORPUS.map(({ name }) => name);

    expect(new Set(names).size).toBe(names.length);
  });

  it.each(CASES)(
    'should keep $name byte-identical to the recorded golden',
    ({ name, variant, entry }) => {
      const actual = renderGolden(prepare(entry, variant));
      const file = `${GOLDEN_DIRECTORY}${name}.txt`;

      if (IS_CAPTURE) {
        writeFileSync(file, actual);
      }

      expect(actual).toBe(readFileSync(file, 'utf8'));
    },
  );

  it('should leave no golden file without a case and no case without a golden file', () => {
    const expected = CASES.map(({ name }) => `${name}.txt`).sort();

    expect(readdirSync(GOLDEN_DIRECTORY).sort()).toEqual(expected);
  });
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
    return prepareResult(
      entry.result,
      { ...entry.options, json: variant === 'json' },
      streams,
    );
  } finally {
    vi.useRealTimers();
    streams.stdout.destroy();
    streams.stderr.destroy();
  }
}

/**
 * serializes a prepared result so that equal text means equal output
 * @param prepared channel, text and notes
 * @returns a length-prefixed record that cannot be confused by its content
 */
function renderGolden(prepared: PreparedResult): string {
  const { channel, text, notes } = prepared;

  return [
    `channel: ${channel}`,
    `text-length: ${text.length}`,
    `notes-length: ${notes === undefined ? 'none' : notes.length}`,
    '=== text ===',
    text,
    '=== notes ===',
    notes ?? '',
    '',
  ].join('\n');
}
