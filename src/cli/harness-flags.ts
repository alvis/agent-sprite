import { catalog } from '#core/catalog';
import { harnessIds } from '#core/harnesses';
import { recordFrom } from '#utilities/records';

import type { HarnessPluginOptions } from '#command/contracts';
import type { HarnessId } from '#core/catalog';

/** a boolean flag that also accepts its --no- form */
interface PairedBooleanFlag {
  readonly kind: 'boolean';
  readonly optional: true;
  readonly withNegated: true;
  readonly brief: string;
}

/** a repeatable string flag */
interface RepeatableFlag {
  readonly kind: 'parsed';
  readonly parse: StringConstructor;
  readonly optional: true;
  readonly variadic: true;
  readonly placeholder: 'SOURCE' | 'PLUGIN';
  readonly brief: string;
}

/** harness id with its first letter capitalized, as camel-case flag keys embed it */
type Embedded = Capitalize<HarnessId>;

/** keys of the repeatable per-harness plugin selection flags */
type RepeatablePluginFlagKey = `${HarnessId}Marketplace` | `${HarnessId}Plugin`;

/** keys of the setup-only per-harness plugin change flags */
type PluginChangeFlagKey =
  | `remove${Embedded}Marketplace`
  | `disable${Embedded}Plugin`
  | `uninstall${Embedded}Plugin`;

/** per-harness plugin selection flags, named from each harness id */
type HarnessPluginFlags = Record<`${HarnessId}Plugins`, PairedBooleanFlag> &
  Record<RepeatablePluginFlagKey, RepeatableFlag>;

/** setup-only per-harness plugin change flags, named from each harness id */
type HarnessPluginChangeFlags = Record<PluginChangeFlagKey, RepeatableFlag>;

/** parsed values of the per-harness plugin selection flags */
export type HarnessPluginSelectionValues = Partial<
  Record<`${HarnessId}Plugins`, boolean> &
    Record<RepeatablePluginFlagKey, string[]>
>;

/** parsed values of every per-harness plugin flag, including setup-only changes */
export type HarnessPluginFlagValues = HarnessPluginSelectionValues &
  Partial<Record<PluginChangeFlagKey, string[]>>;

/** per-harness plugin selection flags for every registered harness */
export const harnessPluginFlags: HarnessPluginFlags = {
  ...recordFrom(
    harnessIds(),
    (id) => `${id}Plugins` as const,
    (id) => toggleFlag(`enable or disable ${displayName(id)} plugins`),
  ),
  ...recordFrom(
    harnessIds(),
    (id) => `${id}Marketplace` as const,
    (id) =>
      repeatableFlag(
        'SOURCE',
        `${displayName(id)} marketplace source (repeatable)`,
      ),
  ),
  ...recordFrom(
    harnessIds(),
    (id) => `${id}Plugin` as const,
    (id) => repeatableFlag('PLUGIN', `${displayName(id)} plugin (repeatable)`),
  ),
};

/** setup-only per-harness plugin change flags for every registered harness */
export const harnessPluginChangeFlags: HarnessPluginChangeFlags = {
  ...recordFrom(
    harnessIds(),
    (id) => `remove${embed(id)}Marketplace` as const,
    (id) => repeatableFlag('SOURCE', `remove ${displayName(id)} marketplace`),
  ),
  ...recordFrom(
    harnessIds(),
    (id) => `disable${embed(id)}Plugin` as const,
    (id) => repeatableFlag('PLUGIN', `disable ${displayName(id)} plugin`),
  ),
  ...recordFrom(
    harnessIds(),
    (id) => `uninstall${embed(id)}Plugin` as const,
    (id) => repeatableFlag('PLUGIN', `uninstall ${displayName(id)} plugin`),
  ),
};

/**
 * lists the kebab-case names of the per-harness boolean plugin flags
 * @returns flag names without leading dashes
 */
export function harnessPluginToggleNames(): string[] {
  return harnessIds().map((id) => `${id}-plugins`);
}

/**
 * folds the flat per-harness plugin flags into records keyed by harness id
 * @param flags parsed flag values
 * @returns selections of every harness with at least one flag supplied
 */
export function harnessPluginOptions(
  flags: HarnessPluginFlagValues,
): Partial<Record<HarnessId, HarnessPluginOptions>> {
  return Object.fromEntries(
    harnessIds().flatMap((id) => {
      const embedded = embed(id);
      const selection: HarnessPluginOptions = {
        isEnabled: flags[`${id}Plugins` as const],
        marketplaces: flags[`${id}Marketplace` as const],
        plugins: flags[`${id}Plugin` as const],
        removeMarketplaces: flags[`remove${embedded}Marketplace` as const],
        disablePlugins: flags[`disable${embedded}Plugin` as const],
        uninstallPlugins: flags[`uninstall${embedded}Plugin` as const],
      };

      return Object.values(selection).some((value) => value !== undefined)
        ? [[id, selection]]
        : [];
    }),
  );
}

/**
 * names one harness the way its help text shows it
 * @param id harness id
 * @returns the harness display name
 */
function displayName(id: HarnessId): string {
  return catalog.harnesses[id].displayName;
}

/**
 * defines a per-harness boolean plugin flag that also accepts its --no- form
 * @param brief help text of the flag
 * @returns typed boolean flag metadata
 */
function toggleFlag(brief: string): PairedBooleanFlag {
  return { kind: 'boolean', optional: true, withNegated: true, brief };
}

/**
 * defines a repeatable native plugin value with its visible help label
 * @param placeholder value kind shown in help
 * @param description action associated with each supplied value
 * @returns typed parsed flag metadata
 */
function repeatableFlag(
  placeholder: 'SOURCE' | 'PLUGIN',
  description: string,
): RepeatableFlag {
  return {
    kind: 'parsed',
    parse: String,
    optional: true,
    variadic: true,
    placeholder,
    brief: `${placeholder} · ${description}`,
  };
}

/**
 * capitalizes a harness id the way camel-case flag keys embed it
 * @param id harness id
 * @returns the id with its first letter capitalized
 */
function embed<Id extends HarnessId>(id: Id): Capitalize<Id> {
  return `${id.charAt(0).toUpperCase()}${id.slice(1)}` as Capitalize<Id>;
}
