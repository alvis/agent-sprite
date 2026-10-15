import {
  chmod,
  lstat,
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ensureNativeDirectory,
  removeNativeFile,
  resolveTrustedFile,
  writeNativeFile,
} from '#guest/native-files';

/** creates canonical host paths corresponding to a managed guest home */
async function nativeTree() {
  const directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-native-files-'),
  );
  const root = await realpath(directory.path);
  const home = join(root, 'home/agent');
  await mkdir(home, { recursive: true });

  return {
    root,
    home,
    [Symbol.asyncDispose]: async () => directory[Symbol.asyncDispose](),
  };
}

describe('native file helper', () => {
  it('should atomically replaces a file with private mode and no temporary residue', async () => {
    await using tree = await nativeTree();
    const { home } = tree;
    const parent = join(home, '.claude');
    const path = join(parent, 'settings.json');
    await ensureNativeDirectory({ home, path: parent });
    await writeFile(path, '{"previous":true}');
    await chmod(path, 0o644);
    const previous = await lstat(path);

    await writeNativeFile({
      home,
      path,
      contents: '{"userSetting":"retained","managed":true}',
    });

    expect(await readFile(path, 'utf8')).toBe(
      '{"userSetting":"retained","managed":true}',
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(path)).ino).not.toBe(previous.ino);
    expect(await readdir(parent)).toEqual(['settings.json']);
  });

  it('should refuse a linked file for writes and removals without changing its target', async () => {
    await using tree = await nativeTree();
    const { root, home } = tree;
    const parent = join(home, '.codex');
    const sentinel = join(root, 'sentinel');
    const linkedFile = join(parent, 'config.toml');
    await mkdir(parent);
    await writeFile(sentinel, 'unchanged');
    await symlink(sentinel, linkedFile);

    await expect(
      writeNativeFile({ home, path: linkedFile, contents: 'replacement' }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringMatching(/linked or has unexpected ownership/),
      }),
    );
    await expect(removeNativeFile({ home, path: linkedFile })).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringMatching(/linked or has unexpected ownership/),
      }),
    );
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
    expect((await lstat(linkedFile)).isSymbolicLink()).toBe(true);
    expect(await readdir(parent)).toEqual(['config.toml']);
  });

  it('should refuse a linked ancestor for mkdir, write, and remove without changing a sentinel', async () => {
    await using tree = await nativeTree();
    const { root, home } = tree;
    const outside = join(root, 'outside');
    const linkedParent = join(home, '.config');
    await mkdir(outside);
    await writeFile(join(outside, 'sentinel'), 'unchanged');
    await symlink(outside, linkedParent);

    await expect(
      ensureNativeDirectory({ home, path: join(linkedParent, 'new') }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringMatching(/linked or has unexpected ownership/),
      }),
    );
    await expect(
      writeNativeFile({
        home,
        path: join(linkedParent, 'sentinel'),
        contents: 'replacement',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringMatching(/linked or has unexpected ownership/),
      }),
    );
    await expect(
      removeNativeFile({ home, path: join(linkedParent, 'sentinel') }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringMatching(/linked or has unexpected ownership/),
      }),
    );
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(await readdir(outside)).toEqual(['sentinel']);
  });

  it('should reject noncanonical and escaped home paths before filesystem mutation', async () => {
    await using tree = await nativeTree();
    const { root, home } = tree;
    const sentinel = join(root, 'sentinel');
    await writeFile(sentinel, 'unchanged');

    for (const path of [
      sentinel,
      `${home}/../sentinel`,
      `${home}/.codex/../sentinel`,
    ]) {
      await expect(
        writeNativeFile({ home, path, contents: 'replacement' }),
      ).rejects.toThrow(/normalized and inside its owning home/);
    }
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
  });
});

describe('fn:resolveTrustedFile', () => {
  it('should accept a root-controlled system executable and refuses user-owned ancestry', async () => {
    expect(await resolveTrustedFile('/bin/sh')).toBe(await realpath('/bin/sh'));
    await using tree = await nativeTree();
    const { root } = tree;
    const file = join(root, 'tool');
    await writeFile(file, 'untrusted');
    await expect(resolveTrustedFile(file)).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringMatching(/Untrusted root execution path/),
      }),
    );
  });

  it('should refuse a user-owned symlink to a system executable', async () => {
    await using tree = await nativeTree();
    const { root } = tree;
    const link = join(root, 'system-tool');
    await symlink('/bin/sh', link);

    await expect(resolveTrustedFile(link)).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringMatching(/Untrusted root execution path/),
      }),
    );
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});
