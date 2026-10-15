import { describe, expect, it } from 'vitest';

import { ComponentLedger } from '#guest/install-tools/ledger';
import { rustComponent } from '#guest/install-tools/rust';

import {
  ranPrograms,
  runnerFor,
  toolsWith,
} from '../../fixtures/install-tools.js';

const RUSTUP = '/usr/local/bin/rustup';
const LIST = `${RUSTUP} toolchain list`;
const PROBE =
  '/usr/bin/env RUSTUP_AUTO_INSTALL=0 /usr/local/bin/rustc --version';
const MANIFEST = [
  'manifest-version = "2"',
  '',
  '[pkg.rust]',
  'version = "1.96.0 (abcdef012 2026-10-01)"',
  '',
].join('\n');

describe('fn:rustComponent', () => {
  it('should install the minimal stable toolchain with clippy and rustfmt, then make it the default', async () => {
    const run = runnerFor({
      // none before the install, and the toolchain once it has run
      [LIST]: [
        'no installed toolchains\n',
        'no installed toolchains\n',
        'stable-x86_64-unknown-linux-gnu (default)\n',
      ],
      [PROBE]: 'rustc 1.96.0 (abcdef012 2026-10-01)\n',
    });
    const tools = toolsWith({
      run,
      downloadText: async () => MANIFEST,
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(rustComponent(tools));

    expect(ranPrograms(run).filter(([program]) => program === RUSTUP)).toEqual([
      [RUSTUP, 'toolchain', 'list'],
      [RUSTUP, 'toolchain', 'list'],
      [
        RUSTUP,
        'toolchain',
        'install',
        'stable',
        '--profile',
        'minimal',
        '--component',
        'clippy,rustfmt',
      ],
      [RUSTUP, 'default', 'stable'],
      [RUSTUP, 'toolchain', 'list'],
    ]);
    expect(ledger.outcomes()).toEqual({
      rust: { status: 'installed', version: '1.96.0' },
    });
  });

  it('should leave a current toolchain alone', async () => {
    const run = runnerFor({
      [LIST]: 'stable-x86_64-unknown-linux-gnu (active, default)\n',
      [PROBE]: 'rustc 1.96.0 (abcdef012 2026-10-01)\n',
    });
    const tools = toolsWith({ run, downloadText: async () => MANIFEST });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(rustComponent(tools));

    expect(ranPrograms(run).filter(([program]) => program === RUSTUP)).toEqual([
      [RUSTUP, 'toolchain', 'list'],
    ]);
    expect(ledger.outcomes()).toEqual({
      rust: { status: 'skipped', version: '1.96.0' },
    });
  });

  it('should update the toolchain it has instead of installing another when a newer release is out', async () => {
    const run = runnerFor({
      [LIST]: 'stable-x86_64-unknown-linux-gnu (active, default)\n',
      [PROBE]: [
        'rustc 1.95.0 (0123456ab 2026-08-01)\n',
        'rustc 1.96.0 (abcdef012 2026-10-01)\n',
      ],
    });
    const tools = toolsWith({ run, downloadText: async () => MANIFEST });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(rustComponent(tools));

    const programs = ranPrograms(run).filter(([program]) => program === RUSTUP);
    expect(programs).toContainEqual([RUSTUP, 'update', 'stable']);
    expect(programs).not.toContainEqual(expect.arrayContaining(['install']));
    expect(programs.at(-2)).toEqual([RUSTUP, 'default', 'stable']);
    expect(ledger.outcomes()).toEqual({
      rust: { status: 'installed', version: '1.96.0' },
    });
  });

  it('should never ask a proxy for the compiler while the toolchain is missing', async () => {
    const run = runnerFor({
      [LIST]: [
        new Error('no toolchain'),
        new Error('no toolchain'),
        'stable-x86_64-unknown-linux-gnu (default)\n',
      ],
      [PROBE]: 'rustc 1.96.0\n',
    });
    const tools = toolsWith({ run, downloadText: async () => MANIFEST });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(rustComponent(tools));

    const first = ranPrograms(run).findIndex(
      ([program]) => program === '/usr/bin/env',
    );
    const installed = ranPrograms(run).findIndex(
      ([program, subcommand]) => program === RUSTUP && subcommand === 'default',
    );
    expect(first).toBeGreaterThan(installed);
  });

  it('should fail to resolve when the manifest lists no compiler release', async () => {
    const run = runnerFor({});
    const tools = toolsWith({ run, downloadText: async () => 'nothing\n' });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(rustComponent(tools));

    expect(ranPrograms(run)).toEqual([]);
    expect(ledger.outcomes()).toEqual({
      rust: {
        status: 'failed',
        error: 'latest version could not be resolved',
      },
    });
  });
});
