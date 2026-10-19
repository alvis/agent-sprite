import type { ProviderCapabilities } from '#domain/declarations';

/** the capability axes of a Fly Sprite */
export const SPRITE_CAPABILITIES: ProviderCapabilities = {
  guestChannel: 'provider-exec',
  // exit nodes were verified live on a Sprite without any exception
  transportNetworks: [],
  keepAwakeMode: 'native-deadline',
  idleForms: ['provider-managed'],
  wakeMode: 'url-traffic',
  supportsCliWakeSleep: false,
  // the Sprite API keeps a task at most an hour
  maxAwakeDeadlineMinutes: 60,
  persistence: 'provider-disk',
  exposure: 'provider-url',
  discovery: 'provider-metadata',
  // a Sprite has one size, so there is nothing to restart
  resizeRestarts: false,
};
