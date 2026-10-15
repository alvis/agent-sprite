import type { ReleaseChannel, ReleaseChannels } from '#drivers/contracts';

/**
 * finds the channel a workstation follows
 * @param channels the channels the agent declares, absent when it declares none
 * @param release the channel the workstation recorded, absent for the default
 * @returns the recorded channel, or the default when none is recorded; nothing
 * when the agent declares no channels or does not declare the recorded one
 */
export function selectedChannel(
  channels: ReleaseChannels | undefined,
  release: string | undefined,
): ReleaseChannel | undefined {
  const id = release ?? channels?.defaultChannel;

  return channels?.channels.find((channel) => channel.id === id);
}
