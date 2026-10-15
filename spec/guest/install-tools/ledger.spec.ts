import { describe, expect, it, vi } from 'vitest';

import { ComponentLedger } from '#guest/install-tools/ledger';

import type {
  ComponentInstall,
  ResolvedRelease,
} from '#guest/install-tools/ledger';

/**
 * describes a component with fixed latest and installed versions
 * @param behaviour what the component's steps do
 * @param behaviour.latest version the source reports, or the reason it cannot
 * @param behaviour.installed version the probe finds before the install, or nothing when absent
 * @param behaviour.afterInstall version the probe finds once the install ran; the latest by default
 * @returns the component and the install step it runs
 */
function componentWith(behaviour: {
  latest: string | Error;
  installed?: string | Error;
  afterInstall?: string;
}): {
  spec: ComponentInstall<ResolvedRelease>;
  install: ReturnType<
    typeof vi.fn<(release: ResolvedRelease) => Promise<void>>
  >;
} {
  let current = behaviour.installed;
  const install = vi.fn<(release: ResolvedRelease) => Promise<void>>(
    async ({ version }) => {
      current = behaviour.afterInstall ?? version;
    },
  );

  return {
    install,
    spec: {
      component: 'tool',
      resolve: async () => {
        if (behaviour.latest instanceof Error) {
          throw behaviour.latest;
        }

        return { version: behaviour.latest };
      },
      installed: async () => {
        if (current instanceof Error) {
          throw current;
        }

        return current;
      },
      install,
    },
  };
}

describe('cl:ComponentLedger', () => {
  describe('mt:ensure', () => {
    it('should skip a component whose installed version equals the latest', async () => {
      const note = vi.fn<(line: string) => void>();
      const ledger = new ComponentLedger(note);
      const { spec, install } = componentWith({
        latest: '2.0.0',
        installed: '2.0.0',
      });

      await ledger.ensure(spec);

      expect(install.mock.calls).toEqual([]);
      expect(ledger.outcomes()).toEqual({
        tool: { status: 'skipped', version: '2.0.0' },
      });
      expect(note.mock.calls).toEqual([
        ['Component tool is current at 2.0.0; skipped'],
        [expect.stringMatching(/^Component tool took \d+ ms$/)],
      ]);
    });

    it('should install the latest version when the installed one differs', async () => {
      const ledger = new ComponentLedger(vi.fn());
      const { spec, install } = componentWith({
        latest: '2.0.0',
        installed: '1.9.0',
      });

      await ledger.ensure(spec);

      expect(install.mock.calls).toEqual([[{ version: '2.0.0' }]]);
      expect(ledger.outcomes()).toEqual({
        tool: { status: 'installed', version: '2.0.0' },
      });
    });

    it('should install a component whose binary is missing', async () => {
      const ledger = new ComponentLedger(vi.fn());
      const { spec, install } = componentWith({ latest: '2.0.0' });

      await ledger.ensure(spec);

      expect(install.mock.calls).toEqual([[{ version: '2.0.0' }]]);
      expect(ledger.outcomes()).toEqual({
        tool: { status: 'installed', version: '2.0.0' },
      });
    });

    it('should fail a component whose latest version cannot be resolved and install nothing', async () => {
      const note = vi.fn<(line: string) => void>();
      const ledger = new ComponentLedger(note);
      const { spec, install } = componentWith({
        latest: new Error('registry unreachable'),
        installed: '1.0.0',
      });

      await ledger.ensure(spec);

      expect(install.mock.calls).toEqual([]);
      expect(ledger.outcomes()).toEqual({
        tool: {
          status: 'failed',
          error: 'latest version could not be resolved',
        },
      });
      expect(note.mock.calls).toEqual([
        ['Component tool failed: registry unreachable'],
        [expect.stringMatching(/^Component tool took \d+ ms$/)],
      ]);
    });

    it('should fail a component whose probe never reports the installed version', async () => {
      const note = vi.fn<(line: string) => void>();
      const ledger = new ComponentLedger(note);
      const { spec, install } = componentWith({
        latest: '2.0.0',
        installed: '1.0.0',
        afterInstall: '1.0.0',
      });

      await ledger.ensure(spec);

      expect(install.mock.calls).toEqual([[{ version: '2.0.0' }]]);
      expect(ledger.outcomes()).toEqual({
        tool: {
          status: 'failed',
          error: 'installed version does not match the release',
        },
      });
      expect(note.mock.calls).toEqual([
        ['Component tool is 1.0.0; installing 2.0.0'],
        ['Component tool reports 1.0.0 after installing 2.0.0'],
        [expect.stringMatching(/^Component tool took \d+ ms$/)],
      ]);
    });

    it('should fail a component that is still absent after its install', async () => {
      const ledger = new ComponentLedger(vi.fn());
      const { spec } = componentWith({
        latest: '2.0.0',
        afterInstall: undefined,
      });
      const absent = { ...spec, installed: async () => undefined };

      await ledger.ensure(absent);

      expect(ledger.outcomes()).toEqual({
        tool: {
          status: 'failed',
          error: 'installed version does not match the release',
        },
      });
    });

    it('should fail a component whose install throws without recording the raw error', async () => {
      const ledger = new ComponentLedger(vi.fn());
      const { spec, install } = componentWith({
        latest: '2.0.0',
        installed: '1.0.0',
      });
      install.mockRejectedValueOnce(new Error('token ghp_secret rejected'));

      await ledger.ensure(spec);

      expect(ledger.outcomes()).toEqual({
        tool: { status: 'failed', error: 'install failed' },
      });
    });

    it('should fail a component whose probe throws', async () => {
      const ledger = new ComponentLedger(vi.fn());
      const { spec, install } = componentWith({
        latest: '2.0.0',
        installed: new Error('probe crashed'),
      });

      await ledger.ensure(spec);

      expect(install.mock.calls).toEqual([]);
      expect(ledger.outcomes()).toEqual({
        tool: { status: 'failed', error: 'install failed' },
      });
    });

    it('should leave the outcomes so far after every component', async () => {
      const saved: Array<Record<string, unknown>> = [];
      const ledger = new ComponentLedger(
        vi.fn(),
        { node: { status: 'skipped', version: '24.1.0' } },
        async (outcomes) => {
          saved.push(outcomes);
        },
      );
      await ledger.ensure({
        ...componentWith({ latest: '1.0.0', installed: '1.0.0' }).spec,
        component: 'alpha',
      });
      await ledger.ensure({
        ...componentWith({ latest: new Error('down') }).spec,
        component: 'beta',
      });

      expect(saved).toEqual([
        {
          node: { status: 'skipped', version: '24.1.0' },
          alpha: { status: 'skipped', version: '1.0.0' },
        },
        {
          node: { status: 'skipped', version: '24.1.0' },
          alpha: { status: 'skipped', version: '1.0.0' },
          beta: {
            status: 'failed',
            error: 'latest version could not be resolved',
          },
        },
      ]);
    });

    it('should keep the outcomes an earlier step recorded', async () => {
      const ledger = new ComponentLedger(vi.fn(), {
        node: { status: 'skipped', version: '24.1.0' },
      });
      const { spec } = componentWith({ latest: '2.0.0', installed: '2.0.0' });

      await ledger.ensure(spec);

      expect(ledger.outcomes()).toEqual({
        node: { status: 'skipped', version: '24.1.0' },
        tool: { status: 'skipped', version: '2.0.0' },
      });
    });
  });

  describe('mt:assertNoFailures', () => {
    it('should name every failed component after all were tried', async () => {
      const ledger = new ComponentLedger(vi.fn());
      await ledger.ensure({
        ...componentWith({ latest: new Error('down') }).spec,
        component: 'alpha',
      });
      await ledger.ensure({
        ...componentWith({ latest: '1.0.0', installed: '1.0.0' }).spec,
        component: 'beta',
      });
      await ledger.ensure({
        ...componentWith({ latest: new Error('down') }).spec,
        component: 'gamma',
      });

      expect(() => {
        ledger.assertNoFailures();
      }).toThrow(new Error('Components failed: alpha, gamma'));
    });

    it('should accept a run with only installed and skipped components', async () => {
      const ledger = new ComponentLedger(vi.fn());
      await ledger.ensure(componentWith({ latest: '1.0.0' }).spec);

      expect(() => {
        ledger.assertNoFailures();
      }).not.toThrow();
    });
  });
});
