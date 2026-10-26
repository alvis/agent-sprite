import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';
import { describe, expect, inject, it } from 'vitest';

const packedBin = inject('packedBin');

describe('installed CLI automation reporting', () => {
  it('should retain redacted warnings and errors while quiet suppresses routine status', async () => {
    const packageRoot = dirname(dirname(await realpath(packedBin)));
    const reportingUrl = pathToFileURL(
      join(packageRoot, 'lib/cli/reporting.js'),
    ).href;
    const operationUrl = pathToFileURL(
      join(packageRoot, 'lib/kernel/operation.js'),
    ).href;
    const redactionUrl = pathToFileURL(
      join(packageRoot, 'lib/kernel/redaction.js'),
    ).href;
    const source = `
      import { createStatusReporter } from ${JSON.stringify(reportingUrl)};
      import { OperationContext } from ${JSON.stringify(operationUrl)};
      import { rememberSecret } from ${JSON.stringify(redactionUrl)};
      const secret = 'pol03-status-private-token';
      rememberSecret(secret);
      const request = { command: 'list', options: { quiet: true } };
      const operation = new OperationContext({
        signal: new AbortController().signal,
        onStatus: createStatusReporter(request, () => undefined),
      });
      operation.reportStatus({ kind: 'info', message: 'Routine info' });
      operation.reportStatus({ kind: 'success', message: 'Routine success' });
      operation.reportStatus({ kind: 'warning', message: 'Warning ' + secret });
      operation.reportStatus({ kind: 'error', message: 'Error ' + secret });
      operation.close();
    `;
    const result = await execa(
      execPath,
      ['--input-type=module', '-e', source],
      {
        env: { PATH: process.env.PATH },
        extendEnv: false,
        reject: false,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Warning: Warning [REDACTED]');
    expect(result.stderr).toContain('Error: Error [REDACTED]');
    expect(result.stderr).not.toContain('Routine');
    expect(result.stderr).not.toContain('pol03-status-private-token');
  });

  it('should keep real stage progress on stderr and one JSON result on stdout across quiet modes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'open-agent-progress-'));
    try {
      const secret = 'pol03-selected-env-private-value';
      const envPath = join(cwd, 'selected.env');
      await writeFile(envPath, `UNRELATED_PRIVATE_VALUE=${secret}\n`);
      const environment = {
        PATH: process.env.PATH,
        HOME: cwd,
        TMPDIR: cwd,
        NO_COLOR: '1',
      };
      const args = [
        'list',
        '--json',
        '--no-local-credentials',
        '--credential-file',
        envPath,
      ];
      const [ordinary, quiet, verboseQuiet, human, quietHuman] =
        await Promise.all([
          execa(packedBin, args, {
            cwd,
            env: environment,
            extendEnv: false,
            reject: false,
          }),
          execa(packedBin, [...args, '--quiet'], {
            cwd,
            env: environment,
            extendEnv: false,
            reject: false,
          }),
          execa(packedBin, [...args, '--quiet', '--verbose'], {
            cwd,
            env: environment,
            extendEnv: false,
            reject: false,
          }),
          execa(
            packedBin,
            ['list', '--no-local-credentials', '--credential-file', envPath],
            {
              cwd,
              env: environment,
              extendEnv: false,
              reject: false,
            },
          ),
          execa(
            packedBin,
            [
              'list',
              '--quiet',
              '--no-local-credentials',
              '--credential-file',
              envPath,
            ],
            { cwd, env: environment, extendEnv: false, reject: false },
          ),
        ]);

      for (const result of [ordinary, quiet, verboseQuiet]) {
        expect(result.exitCode).toBe(1);
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          schemaVersion: 1,
          command: 'list',
          ok: false,
          error: { code: 'INPUT' },
        });
        expect(result.stdout).not.toContain(secret);
        expect(result.stderr).not.toContain(secret);
      }
      expect(ordinary.stderr).toMatch(/environment: started/u);
      expect(ordinary.stderr).toMatch(/environment: completed \(\d+ ms\)/u);
      expect(ordinary.stderr).toMatch(/command: started/u);
      expect(ordinary.stderr).toMatch(/command: failed \(\d+ ms\)/u);
      expect(quiet.stderr).toBe('');
      expect(verboseQuiet.stderr).toContain(
        '[verbose] stage=environment event=start',
      );
      expect(verboseQuiet.stderr).toContain('stage=command event=complete');
      expect(verboseQuiet.stderr).not.toContain('environment: started');
      expect(human.exitCode).toBe(1);
      expect(human.stdout).toBe('');
      expect(human.stderr).toContain('environment: started');
      expect(human.stderr).toContain('command: failed');
      expect(human.stderr).toContain('Set SPRITES_TOKEN');
      expect(human.stderr).not.toContain(secret);
      expect(quietHuman.exitCode).toBe(1);
      expect(quietHuman.stdout).toBe('');
      expect(quietHuman.stderr).toContain('Set SPRITES_TOKEN');
      expect(quietHuman.stderr).not.toContain('environment: started');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('should explain a non-terminal stdin only when it implicitly blocks a needed prompt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'open-agent-prompt-mode-'));
    try {
      const environment = {
        PATH: process.env.PATH,
        HOME: cwd,
        TMPDIR: cwd,
        NO_COLOR: '1',
      };
      const human = await execa(packedBin, ['terminate', 'review-check'], {
        cwd,
        env: environment,
        extendEnv: false,
        reject: false,
      });

      expect(human.exitCode).toBe(2);
      expect(human.stdout).toBe('');
      expect(human.stderr).toContain('stdin is not a terminal');
      expect(human.stderr).toContain('pass required flags or run in a TTY');
      expect(human.stderr).not.toContain('Sprites API token');

      const explicit = await execa(
        packedBin,
        ['terminate', 'review-check', '--json'],
        { cwd, env: environment, extendEnv: false, reject: false },
      );
      expect(explicit.exitCode).toBe(2);
      expect(explicit.stderr).toBe('');
      expect(explicit.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(explicit.stdout)).toMatchObject({
        schemaVersion: 1,
        command: 'terminate',
        ok: false,
        error: { code: 'USAGE' },
      });
      expect(explicit.stdout).not.toContain('stderr is not a terminal');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
