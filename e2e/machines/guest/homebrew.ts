import { HOMEBREW } from '../layout';

import { asRoot } from './execution';
import { readLoginVersion } from './tools';

import type { MachineProvider } from '../providers';

/** what the workstation's Git and Homebrew look like from the guest */
export interface HomebrewGit {
  /** version `git --version` reports to the agent's login shell */
  agentVersion?: string;
  /** the Git the agent's login shell runs */
  agentGit?: string;
  /** the agent's login shell's `EDITOR` and `VISUAL`, then the nano it runs */
  agentEditor: string[];
  /** Git's installed keg as Homebrew lists it, without its revision */
  kegVersion?: string;
  /** where the agent's `git`, `jj` and `gh` resolve */
  links: Record<(typeof BREW_TOOLS)[number], string>;
  /** paths under the prefix the agent account can write; must be none */
  agentWritable: string[];
  /** the prefix's owner and mode, and those of the file the brew command links to */
  owners: string[];
  /** the receipts of kegs Homebrew built rather than poured from a bottle; must be none */
  unbottledKegs: string[];
}

/** the tools a workstation pours from Homebrew bottles */
export const BREW_TOOLS = ['git', 'jj', 'gh'] as const;

/**
 * reads the workstation's Git and Homebrew as the agent and root see them
 * @param provider selected provider
 * @param name exact workstation name
 * @returns what the guest reports
 */
export async function readHomebrewGit(
  provider: MachineProvider,
  name: string,
): Promise<HomebrewGit> {
  const brew = `cd ${HOMEBREW.home} && runuser -u ${HOMEBREW.account} -- env -i HOME=${HOMEBREW.home} PATH=/usr/bin:/bin HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 ${HOMEBREW.brew}`;
  const section = async (script: string): Promise<string[]> =>
    (await asRoot(provider, name, script))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const [keg] = await section(`${brew} list --versions git`);

  return {
    agentVersion: await readLoginVersion(provider, name, 'git'),
    agentGit: (await section("runuser -l agent -c 'command -v git'"))[0],
    agentEditor: await section(
      `runuser -l agent -c 'echo "$EDITOR"; echo "$VISUAL"; command -v nano'`,
    ),
    kegVersion: keg?.split(/\s/)[1]?.replace(/_\d+$/, ''),
    links: Object.fromEntries(
      await Promise.all(
        BREW_TOOLS.map(async (tool) => [
          tool,
          (
            await section(
              `readlink -f "$(runuser -l agent -c 'command -v ${tool}')"`,
            )
          )[0] ?? '',
        ]),
      ),
    ) as HomebrewGit['links'],
    agentWritable: await section(
      `runuser -u agent -- find ${HOMEBREW.home} -writable 2>/dev/null | head -20`,
    ),
    owners: await section(
      `stat -L -c '%U %G %a %n' ${HOMEBREW.home} ${HOMEBREW.prefix} ${HOMEBREW.brew}`,
    ),
    unbottledKegs: await section(
      `for receipt in ${HOMEBREW.prefix}/Cellar/*/*/INSTALL_RECEIPT.json; do test -e "$receipt" || continue; grep -q '"poured_from_bottle": *true' "$receipt" || echo "$receipt"; done`,
    ),
  };
}
