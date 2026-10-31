import { describe, expect, it } from 'vitest';

import { debianFamily } from '#adapters/guest/os/debian/family';
import { resolveTools } from '#adapters/guest/tools/resolve';

import type { OsConstraint, OsRelease } from '#domain/guest';
import type { ToolSpec } from '#domain/tools';

const release = {
  family: 'debian',
  id: 'debian',
  versionId: '12',
  arch: 'x86_64',
  libc: 'glibc',
} satisfies OsRelease;
const target = { release, family: debianFamily };
const tool = {
  name: 'tool',
  required: false,
  executables: ['tool'],
  version: { executable: 'tool', args: ['--version'], account: 'agent' },
  sources: [{ kind: 'npm', package: 'tool', account: 'agent' }],
} satisfies ToolSpec;

describe('fn:resolveTools', () => {
  it.each([
    { reason: 'duplicate', tools: [tool, tool], message: /Two tools/u },
    {
      reason: 'cycle',
      tools: [{ ...tool, needs: ['tool'] }],
      message: /cycle/u,
    },
  ])(
    'should refuse invalid dependency declarations ($reason)',
    ({ tools, message }) => {
      expect(() => resolveTools(tools, target)).toThrow(message);
    },
  );

  it.each([
    {
      reason: 'missing',
      tools: [{ ...tool, needs: ['absent'] }],
      message: /no tool provides/u,
    },
    {
      reason: 'unavailable',
      tools: [
        { ...tool, needs: ['base'] },
        {
          ...tool,
          name: 'base',
          sources: [{ kind: 'brew', formula: 'base', when: { ids: [] } }],
        },
      ],
      message: /unavailable/u,
    },
  ] satisfies Array<{ reason: string; tools: ToolSpec[]; message: RegExp }>)(
    'should explain an unavailable dependency ($reason)',
    ({ tools, message }) => {
      expect(resolveTools(tools, target)[0]).toEqual({
        tool: 'tool',
        unavailable: expect.stringMatching(message),
      });
    },
  );

  it('should retry another source after the guest refuses an exact tool and source pair', () => {
    const first = tool.sources[0];
    const second = { ...first, package: 'replacement' };
    expect(
      resolveTools([{ ...tool, sources: [first, second] }], target, [
        { tool: 'unrelated', source: first, reason: 'not this tool' },
        {
          tool: 'tool',
          source: { ...first, package: 'ignored' },
          reason: 'different source',
        },
        { tool: 'tool', source: first, reason: 'no package' },
      ]),
    ).toEqual([{ tool: 'tool', source: second }]);
  });

  it.each([
    { reason: 'family', when: { families: [] } },
    { reason: 'distribution', when: { ids: ['ubuntu'] } },
    { reason: 'architecture', when: { arch: ['aarch64'] } },
    { reason: 'C library', when: { libc: 'musl' } },
  ] satisfies Array<{ reason: string; when: OsConstraint }>)(
    'should refuse a source outside its OS constraint ($reason)',
    ({ when }) => {
      expect(
        resolveTools(
          [{ ...tool, sources: [{ kind: 'brew', formula: 'tool', when }] }],
          target,
        ),
      ).toEqual([
        { tool: 'tool', unavailable: expect.stringContaining('not for') },
      ]);
    },
  );

  it('should report why Homebrew cannot serve a required tool on an old release', () => {
    expect(() =>
      resolveTools(
        [
          {
            ...tool,
            required: true,
            sources: [{ kind: 'brew', formula: 'tool' }],
          },
        ],
        { ...target, release: { ...release, versionId: '1' } },
      ),
    ).toThrow(/cannot install/u);
  });
});
