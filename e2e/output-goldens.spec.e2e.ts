import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, inject, it } from 'vitest';

import { runOffline } from './fixtures/network-block';

/** one invocation of the installed CLI whose complete output is recorded */
interface GoldenCommand {
  name: string;
  args: string[];
}

const packedBin = inject('packedBin');
const GOLDEN_DIRECTORY = fileURLToPath(
  new URL('fixtures/goldens/', import.meta.url),
);
const IS_CAPTURE = env.OPEN_AGENT_CAPTURE_GOLDENS === '1';
const HOME_PLACEHOLDER = '<HOME>';
const DURATION_PLACEHOLDER = '(<N> ms)';

/** every command that fails or answers before a provider is needed */
const COMMANDS: GoldenCommand[] = [
  { name: 'help', args: ['--help'] },
  { name: 'version', args: ['--version'] },
  { name: 'unknown-command-human', args: ['no-such-command'] },
  { name: 'unknown-command-json', args: ['no-such-command', '--json'] },
  { name: 'invalid-flag-human', args: ['list', '--no-such-flag'] },
  { name: 'invalid-flag-json', args: ['list', '--no-such-flag', '--json'] },
  { name: 'list-json', args: ['list', '--json'] },
  { name: 'list-piped', args: ['list'] },
  { name: 'show-missing-json', args: ['show', 'missing', '--json'] },
  {
    name: 'create-missing-inputs-json',
    args: ['create', '--json', '--non-interactive'],
  },
  { name: 'doctor-missing', args: ['doctor', 'missing'] },
  { name: 'terminate-missing-json', args: ['terminate', 'missing', '--json'] },
];

if (IS_CAPTURE) {
  rmSync(GOLDEN_DIRECTORY, { recursive: true, force: true });
  mkdirSync(GOLDEN_DIRECTORY, { recursive: true });
}

describe('cmd:open-agent output', () => {
  it('should characterize every command under a unique name', () => {
    const names = COMMANDS.map(({ name }) => name);

    expect(new Set(names).size).toBe(names.length);
  });

  it.each(COMMANDS)(
    'should keep the output of $name byte-identical without any provider call',
    async ({ name, args }) => {
      const { golden, attempts } = await record(args);
      const file = `${GOLDEN_DIRECTORY}${name}.txt`;

      if (IS_CAPTURE) {
        writeFileSync(file, golden);
      }

      expect(attempts).toEqual([]);
      expect(golden).toBe(readFileSync(file, 'utf8'));
    },
  );

  it('should leave no golden file without a command and no command without a golden file', () => {
    const expected = COMMANDS.map(({ name }) => `${name}.txt`).sort();

    expect(readdirSync(GOLDEN_DIRECTORY).sort()).toEqual(expected);
  });
});

/**
 * runs the installed CLI with no provider credential, in a home of its own, and
 * renders everything it produced
 * @param args command and flags
 * @returns the length-prefixed record of exit code and both streams, and the
 * outbound attempts the network hook blocked
 */
async function record(
  args: string[],
): Promise<{ golden: string; attempts: unknown[] }> {
  const home = mkdtempSync(join(tmpdir(), 'oa-golden-'));
  try {
    const { result, attempts } = await runOffline(packedBin, args, {
      cwd: home,
      env: {
        PATH: env.PATH,
        HOME: home,
        TMPDIR: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        NO_COLOR: '1',
        SPRITES_TOKEN: '',
        FLY_API_TOKEN: '',
        TAILSCALE_API_KEY: '',
        GH_TOKEN: '',
      },
    });
    const stdout = normalize(result.stdout, home);
    const stderr = normalize(result.stderr, home);

    return {
      golden: [
        `args: ${args.join(' ')}`,
        `exit-code: ${result.exitCode}`,
        `stdout-length: ${stdout.length}`,
        `stderr-length: ${stderr.length}`,
        '=== stdout ===',
        stdout,
        '=== stderr ===',
        stderr,
        '',
      ].join('\n'),
      attempts,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * replaces what differs between runs of the same command: the run's home,
 * however the platform spells it, and the milliseconds a stage reports
 * @param text captured output
 * @param home the home the CLI ran in
 * @returns output that depends on neither the temporary directory nor timing
 */
function normalize(text: string, home: string): string {
  return text
    .replaceAll(realpathSync(home), HOME_PLACEHOLDER)
    .replaceAll(home, HOME_PLACEHOLDER)
    .replaceAll(/\(\d+ ms\)/gu, DURATION_PLACEHOLDER);
}
