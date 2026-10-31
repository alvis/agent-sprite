import { describe, expect, it, vi } from 'vitest';

import { copyUrl } from '#adapters/host/clipboard';

const { sendLocalInput } = vi.hoisted(
  () =>
    ({ sendLocalInput: vi.fn(async () => undefined) }) satisfies Partial<
      typeof import('#adapters/host/process')
    >,
);

vi.mock(
  '#adapters/host/process',
  () =>
    ({ sendLocalInput }) satisfies Partial<
      typeof import('#adapters/host/process')
    >,
);

describe('fn:copyUrl', () => {
  it.each([
    { platform: 'darwin', display: '', program: 'pbcopy', arguments: [] },
    {
      platform: 'linux',
      display: 'wayland-0',
      program: 'wl-copy',
      arguments: [],
    },
    {
      platform: 'linux',
      display: '',
      program: 'xclip',
      arguments: ['-selection', 'clipboard'],
    },
  ])(
    'should deliver the URL through $program on $platform',
    async (scenario) => {
      vi.stubGlobal('process', { ...process, platform: scenario.platform });
      vi.stubEnv('WAYLAND_DISPLAY', scenario.display);

      await copyUrl('https://workstation.example');

      expect(sendLocalInput.mock.calls).toEqual([
        [
          {
            program: scenario.program,
            arguments: scenario.arguments,
            input: 'https://workstation.example',
          },
        ],
      ]);
    },
  );
});
