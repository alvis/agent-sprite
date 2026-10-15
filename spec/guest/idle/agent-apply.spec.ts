import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyAsAgentAccount } from '#guest/idle/agent-apply';

const AT = '2026-10-13T12:00:00.000Z';
const ACCOUNT = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
const RESULT = { at: AT, action: 'apply-deadline', result: AT };

/**
 * writes an apply entry that records the process it ran in, then runs a body
 * @param directory absolute directory for the entry and its record
 * @param body script statements run after the record is written
 * @returns absolute entry path
 */
async function writeEntry(directory: string, body: string): Promise<string> {
  const entry = join(directory, 'apply.mjs');
  const record = join(directory, 'process.json');
  // macOS adds its own __CF_ variables to every process it starts
  await writeFile(
    entry,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, uid: process.getuid(), gid: process.getgid(), argv: process.argv.slice(2), env: Object.keys(process.env).filter((name) => !name.startsWith('__CF_')).sort(), cwd: process.cwd() }));`,
      body,
      '',
    ].join('\n'),
  );

  return entry;
}

/**
 * reads what the apply entry recorded about its process
 * @param directory absolute directory of the entry
 * @returns the decoded record, or undefined when the entry never ran
 */
async function processRecord(directory: string): Promise<unknown> {
  return readFile(join(directory, 'process.json'), 'utf8').then(
    (text): unknown => JSON.parse(text),
    () => undefined,
  );
}

describe('fn:applyAsAgentAccount', () => {
  it('should run the entry as the agent account in its own process with no arguments and return its result', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-agent-apply-'),
    );
    const entry = await writeEntry(
      directory.path,
      `process.stdout.write(${JSON.stringify(JSON.stringify(RESULT))});`,
    );

    const result = await applyAsAgentAccount({
      entry,
      account: ACCOUNT,
      limitMs: 2_500,
      at: AT,
    });

    expect(result).toEqual(RESULT);
    expect(await processRecord(directory.path)).toEqual({
      pid: expect.not.toBeOneOf([process.pid]),
      uid: ACCOUNT.uid,
      gid: ACCOUNT.gid,
      argv: [],
      env: ['HOME', 'PATH'],
      cwd: '/',
    });
  });

  it.each([
    ['an unknown agent account', undefined, 'the agent account is unknown'],
    [
      'the root account',
      { uid: 0, gid: 0 },
      'a native-deadline adapter never runs as root',
    ],
  ])(
    'should refuse %s without starting the entry',
    async (...[, account, failure]) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'oa-agent-apply-'),
      );
      const entry = await writeEntry(directory.path, '');

      const result = await applyAsAgentAccount({
        entry,
        account,
        limitMs: 2_500,
        at: AT,
      });

      expect(result).toEqual({
        at: AT,
        action: 'apply-deadline',
        failure: expect.stringContaining(failure),
      });
      expect(await processRecord(directory.path)).toBeUndefined();
    },
  );

  it('should end an entry that outlasts the limit', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-agent-apply-'),
    );
    const entry = await writeEntry(
      directory.path,
      'setInterval(() => {}, 1000);',
    );

    const result = await applyAsAgentAccount({
      entry,
      account: ACCOUNT,
      limitMs: 300,
      at: AT,
    });

    expect(result).toEqual({
      at: AT,
      action: 'apply-deadline',
      failure: 'the agent-account apply did not finish within 300 ms',
    });
  });

  it('should ask the entry to stop before it is killed, so it can give up its lock', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-agent-apply-'),
    );
    const marker = join(directory.path, 'stopped');
    const entry = await writeEntry(
      directory.path,
      [
        `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(marker)}, 'released'); process.exit(0); });`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );

    const result = await applyAsAgentAccount({
      entry,
      account: ACCOUNT,
      limitMs: 1_500,
      at: AT,
    });

    expect(await readFile(marker, 'utf8')).toBe('released');
    expect(result).toMatchObject({
      action: 'apply-deadline',
      failure: expect.any(String),
    });
  });

  it.each([
    ['output that is not JSON', "process.stdout.write('not json');"],
    [
      'a result of the wrong shape',
      `process.stdout.write(${JSON.stringify(JSON.stringify({ ...RESULT, action: 'reboot' }))});`,
    ],
    [
      'an oversized result',
      `process.stdout.write(${JSON.stringify(JSON.stringify({ ...RESULT, failure: 'x'.repeat(5000) }))});`,
    ],
  ])('should refuse %s', async (_, body) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-agent-apply-'),
    );
    const entry = await writeEntry(directory.path, body);

    const result = await applyAsAgentAccount({
      entry,
      account: ACCOUNT,
      limitMs: 2_500,
      at: AT,
    });

    expect(result).toEqual({
      at: AT,
      action: 'apply-deadline',
      failure: 'the agent-account apply returned no result',
    });
  });
});
