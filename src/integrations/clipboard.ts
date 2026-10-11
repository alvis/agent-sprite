import { sendLocalInput } from '#utilities/process';

/**
 * copies one URL through the host platform's clipboard tool
 * @param url provider T3 URL to copy
 */
export async function copyUrl(url: string): Promise<void> {
  if (process.platform === 'darwin') {
    await sendLocalInput({ program: 'pbcopy', arguments: [], input: url });
  } else if (process.env.WAYLAND_DISPLAY) {
    await sendLocalInput({ program: 'wl-copy', arguments: [], input: url });
  } else {
    await sendLocalInput({
      program: 'xclip',
      arguments: ['-selection', 'clipboard'],
      input: url,
    });
  }
}
