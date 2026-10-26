import type { SystemRepository, ToolSpec } from '#domain/tools';

/** the Tailscale signing key, pinned to its primary key's fingerprint; one key signs every distribution's repository */
const TAILSCALE_KEY: SystemRepository['key'] = {
  url: 'https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg',
  fingerprints: ['2596A99EAAB33821893C0A79458CA832957F5868'],
};

/**
 * declares Tailscale's stable repository for one distribution, which it
 * publishes per release codename
 * @param distribution the distribution's `ID`, which names its repository path
 * @returns the signed repository
 */
function tailscaleRepository(distribution: string): SystemRepository {
  return {
    id: 'tailscale',
    key: TAILSCALE_KEY,
    debian: {
      uri: `https://pkgs.tailscale.com/stable/${distribution}`,
      suite: '{codename}',
      components: ['main'],
    },
  };
}

/**
 * the Tailscale client while a workstation selects it: Homebrew's bottle
 * first; where it has none, Tailscale's signed package, whose own
 * `tailscaled` unit is masked so only open-agent's daemon service runs. The
 * probe finds the tool on the PATH, as the link to the bottle or the
 * package's own `/usr/bin/tailscale`; its launcher and exit-route probe run
 * `ip`, so `iproute2`, optional on its own, is needed whenever this network
 * is selected
 */
export const tailscaleTool: ToolSpec = {
  name: 'tailscale',
  required: true,
  needs: ['iproute2'],
  executables: ['tailscale', 'tailscaled'],
  version: { executable: 'tailscale', args: ['version'], account: 'root' },
  sources: [
    { kind: 'brew', formula: 'tailscale' },
    ...(['debian', 'ubuntu'] as const).map((distribution) => ({
      kind: 'system' as const,
      family: 'debian' as const,
      packages: ['tailscale'],
      repository: tailscaleRepository(distribution),
      vendorServices: ['tailscaled.service'],
      when: { ids: [distribution] },
    })),
  ],
};
