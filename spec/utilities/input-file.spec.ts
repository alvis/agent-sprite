import { execFile } from 'node:child_process';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { OperationContext, withOperation } from '#operation';
import { readInputFile } from '#utilities/input-file';

const execFileAsync = promisify(execFile);

describe('fn:readInputFile', () => {
  it('should read a selected regular file under an invocation scope', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-input-file-'),
    );
    const path = join(directory.path, 'selected.env');
    await writeFile(path, 'SAMPLE=value\n');
    const context = new OperationContext({
      signal: new AbortController().signal,
    });

    const contents = await withOperation(context, async () =>
      readInputFile(path),
    );

    expect(contents).toBe('SAMPLE=value\n');
  });

  it('should reject a FIFO promptly without waiting for a writer', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-input-fifo-'),
    );
    const path = join(directory.path, 'selected.env');
    await execFileAsync('mkfifo', [path]);
    const context = new OperationContext({
      signal: new AbortController().signal,
    });

    await expect(
      withOperation(context, async () => readInputFile(path)),
    ).rejects.toMatchObject({ code: 'INPUT' });
  });

  it('should open no file for an already cancelled invocation', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-input-abort-'),
    );
    const path = join(directory.path, 'selected.env');
    await writeFile(path, 'SAMPLE=value\n');
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    controller.abort();

    await expect(
      withOperation(context, async () => readInputFile(path)),
    ).rejects.toMatchObject({
      action: 'cancel',
    });
  });
});
