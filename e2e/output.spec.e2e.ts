import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';

import { describe, expect, inject, it } from 'vitest';

import { runOffline } from './fixtures/network-block';

/** one installed CLI invocation and its expected consumer-visible result */
interface CommandCase {
  name: string;
  args: string[];
  exitCode: number;
  command?: string | null;
  errorCode?: string;
  progress?: boolean;
  output?: RegExp;
}

const packedBin = inject('packedBin');

/** commands that can answer without a provider credential */
const COMMANDS: CommandCase[] = [
  {
    name: 'help',
    args: ['--help'],
    exitCode: 0,
    output: /USAGE.*open-agent create/su,
  },
  {
    name: 'version',
    args: ['--version'],
    exitCode: 0,
    output: /^\d+\.\d+\.\d+\n?$/u,
  },
  {
    name: 'unknown-command-human',
    args: ['no-such-command'],
    exitCode: 2,
    output: /no-such-command/u,
  },
  {
    name: 'unknown-command-json',
    args: ['no-such-command', '--json'],
    exitCode: 2,
    command: null,
    errorCode: 'USAGE',
  },
  {
    name: 'invalid-flag-human',
    args: ['list', '--no-such-flag'],
    exitCode: 2,
    output: /--no-such-flag/u,
  },
  {
    name: 'invalid-flag-json',
    args: ['list', '--no-such-flag', '--json'],
    exitCode: 2,
    command: 'list',
    errorCode: 'USAGE',
  },
  {
    name: 'list-json',
    args: ['list', '--json'],
    exitCode: 1,
    command: 'list',
    errorCode: 'INPUT',
    progress: true,
  },
  {
    name: 'list-piped',
    args: ['list'],
    exitCode: 1,
    output: /provider/iu,
  },
  {
    name: 'show-missing-json',
    args: ['show', 'missing', '--json'],
    exitCode: 1,
    command: 'show',
    errorCode: 'INPUT',
    progress: true,
  },
  {
    name: 'create-missing-inputs-json',
    args: ['create', '--json', '--non-interactive'],
    exitCode: 1,
    command: 'create',
    errorCode: 'INPUT',
    progress: true,
  },
  {
    name: 'doctor-missing',
    args: ['doctor', 'missing'],
    exitCode: 1,
    output: /provider/iu,
  },
  {
    name: 'terminate-missing-json',
    args: ['terminate', 'missing', '--json'],
    exitCode: 2,
    command: 'terminate',
    errorCode: 'USAGE',
  },
];

describe('cmd:open-agent output', () => {
  it.each(COMMANDS)(
    'should give the installed CLI result for $name without a provider call',
    async ({ args, exitCode, command, errorCode, progress, output }) => {
      const home = mkdtempSync(join(tmpdir(), 'oa-output-'));
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

        expect(attempts).toEqual([]);
        expect(result.exitCode).toBe(exitCode);
        if (errorCode) {
          if (progress) {
            expect(result.stderr).toMatch(
              /environment: started[\s\S]*command: failed/u,
            );
          } else {
            expect(result.stderr).toBe('');
          }
          expect(JSON.parse(result.stdout) as unknown).toMatchObject({
            schemaVersion: 1,
            command,
            ok: false,
            error: { code: errorCode, message: expect.any(String) },
          });
        } else if (output) {
          const stream = exitCode === 0 ? result.stdout : result.stderr;

          expect(exitCode === 0 ? result.stderr : result.stdout).toBe('');
          expect(stream.replaceAll(realpathSync(home), '<HOME>')).toMatch(
            output,
          );
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
