import { describe, expect, it } from 'vitest';

import { catalog } from '#core/catalog';
import { isSleepPermitted } from '#guest/idle/permission';

import type { ProviderCapabilities } from '#drivers/contracts';

// fixture providers are typed by the host contract and passed straight into the
// guest rule, so a capability-axis value set drifting between the two fails typecheck
const governedUrlTraffic: ProviderCapabilities = {
  guestChannel: 'provider-exec',
  servicesMode: 'supervised',
  transportNetworks: [],
  keepAwakeMode: 'governed',
  idleForms: ['memory-suspend', 'stop'],
  wakeMode: 'url-traffic',
  supportsCliWakeSleep: false,
  maxAwakeDeadlineMinutes: null,
  persistence: 'volume',
  exposure: 'provider-service',
  discovery: 'provider-metadata',
  resizeRestarts: false,
};
const cliRestoreOptedIn: ProviderCapabilities = {
  ...governedUrlTraffic,
  guestChannel: 'ssh',
  idleForms: ['disk-snapshot'],
  wakeMode: 'cli-restore',
  supportsCliWakeSleep: true,
  persistence: 'snapshot',
  exposure: 'network-only',
};
const cliRestoreNotOptedIn: ProviderCapabilities = {
  ...cliRestoreOptedIn,
  supportsCliWakeSleep: false,
};
const alwaysOn: ProviderCapabilities = {
  ...governedUrlTraffic,
  guestChannel: 'ssh',
  wakeMode: 'always-on',
  persistence: 'host-disk',
  exposure: 'network-only',
};
const neverKeptAwake: ProviderCapabilities = {
  ...governedUrlTraffic,
  keepAwakeMode: 'none',
};

describe('fn:isSleepPermitted', () => {
  it.each([
    ['a governed url-traffic provider', governedUrlTraffic, true],
    ['an opted-in cli-restore provider', cliRestoreOptedIn, true],
    ['a cli-restore provider without opt-in', cliRestoreNotOptedIn, false],
    ['an always-on provider', alwaysOn, false],
    ['a provider open-agent never keeps awake', neverKeptAwake, false],
    [
      'the native-deadline sprite provider',
      catalog.providers.sprite.capabilities,
      false,
    ],
  ])('should decide sleep for %s', (_, capabilities, expected) => {
    expect(isSleepPermitted({ ...capabilities, idleTimeoutMinutes: 5 })).toBe(
      expected,
    );
  });

  it('should never permit sleep when the idle timeout is 0', () => {
    expect(
      isSleepPermitted({ ...governedUrlTraffic, idleTimeoutMinutes: 0 }),
    ).toBe(false);
  });
});
