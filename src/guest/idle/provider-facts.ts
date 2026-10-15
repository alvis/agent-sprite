import type { ProviderComponent } from '../../drivers/component-types.js';

// guest kernel: constants and validators only, with no runtime imports, so the
// host catalog, the guest catalog reader, the state record and the adapter
// loader check a recorded provider's idle facts with one definition

/**
 * an awake adapter: an `-awake` module directly in the guest folder of the
 * provider's own driver, its folder captured to compare with the provider id
 */
const AWAKE_MODULE =
  /^drivers\/providers\/([a-z0-9-]+)\/guest\/[a-z0-9-]+-awake\.js$/;

// every value of the axis, keyed so a value added to the axis fails typecheck
// here until the reader accepts it
const KEEP_AWAKE_MODES: Readonly<
  Record<ProviderComponent['keepAwakeMode'], true>
> = { 'native-deadline': true, 'governed': true, 'none': true };

/**
 * tells whether a module path names an awake adapter of the provider's own
 * guest folder, so nothing else is ever imported as one
 * @param module module path relative to the guest root
 * @param providerId the provider the adapter must belong to
 * @returns true only for `drivers/providers/<id>/guest/<name>-awake.js`
 */
export function isOwnAwakeModule(module: string, providerId: string): boolean {
  return AWAKE_MODULE.exec(module)?.[1] === providerId;
}

/**
 * validates a provider keep-awake mode
 * @param value untrusted decoded field
 * @returns whether the value is one of the axis's values
 */
export function isKeepAwakeMode(
  value: unknown,
): value is ProviderComponent['keepAwakeMode'] {
  return typeof value === 'string' && Object.hasOwn(KEEP_AWAKE_MODES, value);
}
