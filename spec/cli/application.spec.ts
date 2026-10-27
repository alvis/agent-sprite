import process from 'node:process';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { cli } from '#cli/application';
import { parseApplication } from '#cli/parser';

vi.mock('#cli/parser', async (importOriginal) => {
  const original = await importOriginal<typeof import('#cli/parser')>();

  return {
    ...original,
    parseApplication: vi.fn(original.parseApplication),
  } satisfies Partial<typeof import('#cli/parser')>;
});

const parse = vi.mocked(parseApplication);

describe('fn:cli', () => {
  it('should emit a successful JSON list without contacting a provider service', async () => {
    vi.stubEnv('SPRITES_TOKEN', 'test-org/1/0abc/0def');
    vi.stubEnv('FLY_API_TOKEN', '');
    const originalExitCode = process.exitCode;
    const signalListeners = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    let outputText = '';
    let errorText = '';
    let exitCode: typeof process.exitCode;
    using providerList = vi
      .spyOn(SpritesClient.prototype, 'listAllSprites')
      .mockImplementation(async () => []);
    using outbound = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (): Promise<Response> => {
        throw new Error('Unexpected network request');
      });
    vi.spyOn(process.stdout, 'write').mockImplementation((...args): boolean => {
      outputText += String(args[0]);
      const done = args.find((argument) => typeof argument === 'function');
      done?.();

      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((...args): boolean => {
      errorText += String(args[0]);
      const done = args.find((argument) => typeof argument === 'function');
      done?.();

      return true;
    });

    try {
      await cli([
        'list',
        '--provider',
        'sprite',
        '--no-local-credentials',
        '--non-interactive',
        '--quiet',
        '--json',
      ]);
      exitCode = process.exitCode;
    } finally {
      process.exitCode = originalExitCode;
    }

    expect({
      result: JSON.parse(outputText),
      errorText,
      exitCode,
      signalListeners: {
        sigint: process.listenerCount('SIGINT'),
        sigterm: process.listenerCount('SIGTERM'),
      },
    }).toMatchObject({
      result: {
        schemaVersion: 1,
        command: 'list',
        ok: true,
        data: { machines: [] },
      },
      errorText: '',
      exitCode: 0,
      signalListeners,
    });
    expect(outputText.endsWith('\n')).toBe(true);
    expect(providerList.mock.calls).toEqual([[]]);
    expect(outbound.mock.calls).toEqual([]);
  });

  it.each([
    {
      argv: ['show', '--json', '--help'],
      command: 'show',
      message: '--json cannot be combined with help or version.',
    },
    {
      argv: ['show', '--json', '--version'],
      command: 'show',
      message: '--json cannot be combined with help or version.',
    },
    {
      argv: ['unsupported', '--json'],
      command: null,
      message: 'unsupported',
    },
    {
      argv: ['show', '--no-pair', '--json'],
      command: 'show',
      message: '--no-pair was removed',
    },
  ])(
    'should emit one structured usage failure for $argv',
    async ({ argv, command, message }) => {
      const { stdout, stderr, exitCode } = await captureCli(argv);
      const result: unknown = JSON.parse(stdout);

      expect(result).toMatchObject({
        schemaVersion: 1,
        command,
        ok: false,
        error: { code: 'USAGE', message: expect.stringContaining(message) },
      });
      expect(stderr).toBe('');
      expect(exitCode).toBe(2);
    },
  );

  it('should show provider environment guidance in root help', async () => {
    const { stdout, stderr, exitCode } = await captureCli(['--help']);

    expect(stdout).toContain('ENVIRONMENT');
    expect(stdout).toContain('LEARN MORE');
    expect(stdout).toContain('SPRITES_TOKEN');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  it('should report a missing command if parsing returns without output', async () => {
    parse.mockResolvedValueOnce(undefined);

    const { stdout, stderr, exitCode } = await captureCli(['list', '--json']);

    expect(JSON.parse(stdout)).toMatchObject({
      command: 'list',
      ok: false,
      error: { code: 'USAGE', message: 'A command is required.' },
    });
    expect(stderr).toBe('');
    expect(exitCode).toBe(2);
  });

  it('should hide unexpected parser failures behind a generic result', async () => {
    parse.mockRejectedValueOnce(new Error('private parser detail'));

    const { stdout, stderr, exitCode } = await captureCli(['list', '--json']);

    expect(JSON.parse(stdout)).toMatchObject({
      command: 'list',
      ok: false,
      error: {
        code: 'UNEXPECTED',
        message: 'The command could not complete safely.',
      },
    });
    expect(stdout).not.toContain('private parser detail');
    expect(stderr).toBe('');
    expect(exitCode).toBe(1);
  });

  it('should leave an already emitted result untouched after a parser throw', async () => {
    parse.mockImplementationOnce(async (_application, _argv, context) => {
      context.state.emitted = true;
      throw new Error('late parser failure');
    });

    const { stdout, stderr, exitCode } = await captureCli(['list', '--json']);

    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(exitCode).toBeUndefined();
  });
});

/**
 * captures one real CLI invocation without leaking process streams or exit status
 * @param argv command arguments
 * @returns process output and status
 */
async function captureCli(argv: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: typeof process.exitCode;
}> {
  let stdout = '';
  let stderr = '';
  const originalExitCode = process.exitCode;
  using output = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((...args) => {
      stdout += String(args[0]);
      const done = args.find((argument) => typeof argument === 'function');
      done?.();

      return true;
    });
  using errors = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((...args) => {
      stderr += String(args[0]);
      const done = args.find((argument) => typeof argument === 'function');
      done?.();

      return true;
    });
  void output;
  void errors;
  try {
    await cli(argv);

    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = originalExitCode;
  }
}
