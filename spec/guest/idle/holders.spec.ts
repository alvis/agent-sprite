import {
  link,
  mkdir,
  mkdtempDisposable,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  hashSession,
  holderFileName,
  removeEntries,
  scanHolders,
  writeHolder,
} from '#guest/idle/holders';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const OWNER = new Set([process.getuid?.() ?? 0]);
const SESSION = hashSession('session-1');
const NAME = holderFileName('claude', SESSION);
const VALID = {
  version: 1,
  source: 'claude',
  session: SESSION,
  lastHeartbeat: NOW,
};
const EMPTY = { holders: [], refused: [], temporaries: [], others: [] };

describe('fn:scanHolders', () => {
  it('should read a holder written under its own hashed name', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    await writeHolder(directory.path, {
      source: 'claude',
      session: SESSION,
      lastHeartbeat: NOW,
      holdExpiresAt: NOW + 60_000,
    });

    const scan = await scanHolders(directory.path, OWNER);

    expect(scan).toEqual({
      holders: [
        {
          name: NAME,
          holder: {
            source: 'claude',
            session: SESSION,
            lastHeartbeat: NOW,
            holdExpiresAt: NOW + 60_000,
          },
        },
      ],
      refused: [],
      temporaries: [],
      others: [],
    });
  });

  it('should read back the process a managed hold belongs to', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    const process = { pid: 7, start: '123' };
    await writeHolder(directory.path, {
      source: 'updater',
      session: SESSION,
      lastHeartbeat: NOW,
      holdExpiresAt: NOW + 60_000,
      process,
    });

    const scan = await scanHolders(directory.path, OWNER);

    expect(scan.holders.map(({ holder }) => holder.process)).toEqual([process]);
  });

  it.each([
    ['malformed JSON', '{"version":1,'],
    ['an unknown version', JSON.stringify({ ...VALID, version: 2 })],
    ['a source with a path', JSON.stringify({ ...VALID, source: '../claude' })],
    ['a raw session', JSON.stringify({ ...VALID, session: 'session-1' })],
    ['a fractional time', JSON.stringify({ ...VALID, lastHeartbeat: 1.5 })],
    ['a process id without a start time', JSON.stringify({ ...VALID, pid: 7 })],
    [
      'a start time without a process id',
      JSON.stringify({ ...VALID, processStart: '7' }),
    ],
    [
      'a process id that is not positive',
      JSON.stringify({ ...VALID, pid: 0, processStart: '7' }),
    ],
    [
      'an oversized file',
      JSON.stringify({ ...VALID, padding: 'x'.repeat(2048) }),
    ],
  ])('should refuse a holder file with %s', async (_, contents) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    await writeFile(join(directory.path, NAME), contents);

    const scan = await scanHolders(directory.path, OWNER);

    expect(scan).toEqual({ ...EMPTY, refused: [NAME] });
  });

  it('should refuse a holder stored under another holder name', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    const foreign = holderFileName('codex', SESSION);
    await writeFile(join(directory.path, foreign), JSON.stringify(VALID));

    const scan = await scanHolders(directory.path, OWNER);

    expect(scan).toEqual({ ...EMPTY, refused: [foreign] });
  });

  it('should refuse a symbolic link without following it', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    await writeFile(join(directory.path, 'target.json'), JSON.stringify(VALID));
    await symlink(
      join(directory.path, 'target.json'),
      join(directory.path, NAME),
    );

    const scan = await scanHolders(directory.path, OWNER);

    expect(scan).toEqual({
      ...EMPTY,
      refused: [NAME],
      others: ['target.json'],
    });
  });

  it('should refuse a hard link to another file', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    await writeFile(join(directory.path, 'target.json'), JSON.stringify(VALID));
    await link(join(directory.path, 'target.json'), join(directory.path, NAME));

    const scan = await scanHolders(directory.path, OWNER);

    expect(scan).toEqual({
      ...EMPTY,
      refused: [NAME],
      others: ['target.json'],
    });
  });

  it('should refuse a holder owned by a foreign account', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    await writeFile(join(directory.path, NAME), JSON.stringify(VALID));

    // no accepted owner is this test's account
    const scan = await scanHolders(
      directory.path,
      new Set([(process.getuid?.() ?? 0) + 1]),
    );

    expect(scan).toEqual({ ...EMPTY, refused: [NAME] });
  });

  it('should sort other entries into temporaries and others without reading them', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    await writeFile(join(directory.path, 'notes.txt'), 'not a holder');
    await writeFile(join(directory.path, '.tmp-fresh'), '');

    const scan = await scanHolders(directory.path, OWNER);

    expect(scan).toEqual({
      ...EMPTY,
      temporaries: ['.tmp-fresh'],
      others: ['notes.txt'],
    });
  });

  it('should refuse a directory planted at a holder name and still read the other holders', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    const planted = holderFileName('codex', SESSION);
    await mkdir(join(directory.path, planted));
    await writeHolder(directory.path, {
      source: 'claude',
      session: SESSION,
      lastHeartbeat: NOW,
    });

    const scan = await scanHolders(directory.path, OWNER);

    expect(scan).toEqual({
      ...EMPTY,
      holders: [
        {
          name: NAME,
          holder: { source: 'claude', session: SESSION, lastHeartbeat: NOW },
        },
      ],
      refused: [planted],
    });
  });

  it('should count only holder names against the holder bound', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    for (const index of Array.from({ length: 600 }, (_, at) => at)) {
      await writeFile(join(directory.path, `junk-${index}`), '');
    }
    await writeHolder(directory.path, {
      source: 'claude',
      session: SESSION,
      lastHeartbeat: NOW,
    });

    const scan = await scanHolders(directory.path, OWNER);

    expect(scan.holders).toEqual([
      {
        name: NAME,
        holder: { source: 'claude', session: SESSION, lastHeartbeat: NOW },
      },
    ]);
    expect(scan.others).toHaveLength(600);
    expect(scan.incomplete).toBeUndefined();
  });

  it('should report a scan that could not see every holder', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    for (const index of Array.from({ length: 513 }, (_, at) => at)) {
      await writeHolder(directory.path, {
        source: 'claude',
        session: hashSession(`session-${index}`),
        lastHeartbeat: NOW,
      });
    }

    const scan = await scanHolders(directory.path, OWNER);

    expect(scan.holders).toHaveLength(512);
    expect(scan.incomplete).toBe('it holds more than 512 holder files');
  });

  it('should report a directory it could not read', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );

    const scan = await scanHolders(join(directory.path, 'missing'), OWNER);

    expect(scan).toEqual({ ...EMPTY, incomplete: 'it could not be read' });
  });
});

describe('fn:removeEntries', () => {
  it('should remove the named files and leave an entry it cannot remove', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-holders-'),
    );
    await writeFile(join(directory.path, 'notes.txt'), '');
    await mkdir(join(directory.path, NAME));

    await removeEntries(directory.path, ['notes.txt', NAME, 'gone.txt']);

    expect(await readdir(directory.path)).toEqual([NAME]);
  });
});
