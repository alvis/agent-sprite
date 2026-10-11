import { checkOperation } from '#operation';

import { guestPayloadFrame, readGuestPayload } from '../payloads/assets.js';

import type { Sprite, SpriteCommand } from '@fly/sprites';

const launcher = String.raw`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
install -d -o root -g root -m 0755 /run/lock
exec 9>>/var/lock/agent-sprite-update.lock
flock -w 60 9
temporary=
trap 'if [ -n "$temporary" ]; then rm -f -- "$temporary"; fi; exec 9>&-; printf "{\"type\":\"released\"}\n"' EXIT
printf 'locked\n'
token=$(timeout 60 /bin/sh -c 'IFS= read -r line && printf "%s" "$line"')
[ "$token" = begin ] || exit 1
install -d -o root -g root -m 0755 /opt/agent-sprite
encoded=$(timeout 60 /bin/sh -c 'IFS= read -r line && printf "%s" "$line"')
temporary=$(mktemp /opt/agent-sprite/.transaction-payload.XXXXXX)
printf '%s' "$encoded" | base64 -d >"$temporary"
chmod 0700 "$temporary"
mv -f -- "$temporary" /opt/agent-sprite/bootstrap-node.sh
temporary=
encoded=$(timeout 60 /bin/sh -c 'IFS= read -r line && printf "%s" "$line"')
temporary=$(mktemp /opt/agent-sprite/.transaction-payload.XXXXXX)
printf '%s' "$encoded" | base64 -d >"$temporary"
chmod 0700 "$temporary"
mv -f -- "$temporary" /opt/agent-sprite/guest-transaction.js
temporary=
if [ ! -x /opt/agent-sprite/node/bin/node ]; then
  [ "$1" = 1 ] || exit 1
  timeout 1200 /bin/sh /opt/agent-sprite/bootstrap-node.sh </dev/null
fi
exec /opt/agent-sprite/node/bin/node /opt/agent-sprite/guest-transaction.js --stage
`;

/**
 * starts the lock owner with fixed minimum ingress and compiled staging frames
 * @param sprite exact target guest
 * @param bootstrap whether missing managed Node may be installed
 * @returns private stream and fixed non-secret payload frames
 */
export async function prepareGuestTransaction(
  sprite: Sprite,
  bootstrap: boolean,
): Promise<{ command: SpriteCommand; payloads: string }> {
  const [nodeBootstrap, worker, frame] = await Promise.all([
    readGuestPayload('bootstrap-node.sh'),
    readGuestPayload('guest-transaction.js'),
    guestPayloadFrame(),
  ]);
  checkOperation();
  const command = sprite.spawn(
    '/usr/bin/sudo',
    [
      '-n',
      '-E',
      '--',
      '/bin/sh',
      '-c',
      launcher,
      'agent-sprite-transaction',
      bootstrap ? '1' : '0',
    ],
    { tty: false },
  );

  return {
    command,
    payloads: `begin\n${Buffer.from(nodeBootstrap).toString('base64')}\n${Buffer.from(worker).toString('base64')}\n${frame}\n`,
  };
}
