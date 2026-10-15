import {
  mkdtempDisposable,
  readFile,
  stat,
  writeFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOOL_LINK_DIRECTORY } from '#guest/homebrew';
import { recordLink } from '#guest/install-tools/link-record';

const GH = `${TOOL_LINK_DIRECTORY}/gh`;
const GH_TARGET = '/home/linuxbrew/.linuxbrew/opt/gh/bin/gh';

describe('fn:recordLink', () => {
  it('should record a link in the tool link directory as one path and target line', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-link-record-'),
    );
    const record = join(directory.path, 'links');

    await recordLink(record, GH_TARGET, GH);

    expect(await readFile(record, 'utf8')).toBe(`${GH}\t${GH_TARGET}\n`);
  });

  it('should keep one line per path, replacing the target of a link made again, and keep the other links', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-link-record-'),
    );
    const record = join(directory.path, 'links');
    await recordLink(record, GH_TARGET, GH);
    await recordLink(
      record,
      '/opt/open-agent/tools/tailscale',
      `${TOOL_LINK_DIRECTORY}/tailscale`,
    );

    await recordLink(record, '/elsewhere/gh', GH);

    expect(await readFile(record, 'utf8')).toBe(
      `${GH}\t/elsewhere/gh\n${TOOL_LINK_DIRECTORY}/tailscale\t/opt/open-agent/tools/tailscale\n`,
    );
  });

  it('should write a record readable by every account and leave no temporary file', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-link-record-'),
    );
    const record = join(directory.path, 'links');
    const mask = process.umask(0o077);

    try {
      await recordLink(record, GH_TARGET, GH);
    } finally {
      process.umask(mask);
    }

    expect((await stat(record)).mode & 0o777).toBe(0o644);
    expect(await readdir(directory.path)).toEqual(['links']);
  });

  it('should drop a line of an earlier record that holds no path and target', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-link-record-'),
    );
    const record = join(directory.path, 'links');
    await writeFile(
      record,
      `no separator\n\n${TOOL_LINK_DIRECTORY}/jj\t/opt/jj\n`,
    );

    await recordLink(record, GH_TARGET, GH);

    expect(await readFile(record, 'utf8')).toBe(
      `${TOOL_LINK_DIRECTORY}/jj\t/opt/jj\n${GH}\t${GH_TARGET}\n`,
    );
  });

  it.each([
    [
      'a link outside the tool link directory',
      '/opt/open-agent/node_modules/x',
    ],
    ['a link below it', `${TOOL_LINK_DIRECTORY}/sub/gh`],
    ['a link in a sibling directory', '/usr/local/binx/gh'],
  ])('should not record %s', async (_label, path) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-link-record-'),
    );
    const record = join(directory.path, 'links');

    await recordLink(record, GH_TARGET, path);

    expect(await readdir(directory.path)).toEqual([]);
  });

  it.each([
    ['a relative target', 'opt/gh/bin/gh', GH],
    ['a tab in the target', '/opt/a\tb', GH],
    ['a line break in the path', GH_TARGET, `${TOOL_LINK_DIRECTORY}/g\nh`],
  ])('should refuse %s', async (_label, target, path) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-link-record-'),
    );
    const record = join(directory.path, 'links');

    await expect(recordLink(record, target, path)).rejects.toThrow(
      'cannot be recorded',
    );
    expect(await readdir(directory.path)).toEqual([]);
  });
});
