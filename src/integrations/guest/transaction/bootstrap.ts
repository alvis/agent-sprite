import { GUEST_NODE, GUEST_ROOT, kernelModule } from '#guest/guest-root';
import { UPDATE_LOCK_PATH, lockDirectoryCommand } from '#guest/update-schedule';
import { checkOperation } from '#operation';

import { guestPayloadFrame, readGuestPayload } from '../payloads/assets.js';

import type { GuestChannel, GuestProcess } from '#drivers/guest-channel';

const BOOTSTRAP_MODULE = kernelModule('bootstrap-node.sh');
const BOOTSTRAP_PATH = `${GUEST_ROOT}/${BOOTSTRAP_MODULE}`;
const WORKER_MODULE = kernelModule('guest-transaction.js');
const WORKER_PATH = `${GUEST_ROOT}/${WORKER_MODULE}`;
const launcher = String.raw`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
[ ! -L ${GUEST_ROOT} ] || exit 1
install -d -o root -g root -m 0755 ${GUEST_ROOT}
${lockDirectoryCommand()} || exit 1
exec 9>>${UPDATE_LOCK_PATH}
flock -w 60 9
temporary=
trap 'if [ -n "$temporary" ]; then rm -f -- "$temporary"; fi; exec 9>&-; printf "{\"type\":\"released\"}\n"' EXIT
printf 'locked\n'
token=$(timeout 60 /bin/sh -c 'IFS= read -r line && printf "%s" "$line"')
[ "$token" = begin ] || exit 1
[ ! -L ${GUEST_ROOT} ] && [ ! -L ${GUEST_ROOT}/guest ] || exit 1
install -d -o root -g root -m 0755 ${GUEST_ROOT} ${GUEST_ROOT}/guest
encoded=$(timeout 60 /bin/sh -c 'IFS= read -r line && printf "%s" "$line"')
temporary=$(mktemp ${GUEST_ROOT}/.transaction-payload.XXXXXX)
printf '%s' "$encoded" | base64 -d >"$temporary"
chmod 0700 "$temporary"
mv -f -- "$temporary" ${BOOTSTRAP_PATH}
temporary=
encoded=$(timeout 60 /bin/sh -c 'IFS= read -r line && printf "%s" "$line"')
temporary=$(mktemp ${GUEST_ROOT}/.transaction-payload.XXXXXX)
printf '%s' "$encoded" | base64 -d >"$temporary"
chmod 0700 "$temporary"
mv -f -- "$temporary" ${WORKER_PATH}
temporary=
if [ ! -x ${GUEST_NODE} ]; then
  [ "$1" = 1 ] || exit 1
  timeout 1200 /bin/sh ${BOOTSTRAP_PATH} ${GUEST_ROOT} </dev/null
fi
exec ${GUEST_NODE} ${WORKER_PATH} --stage ${GUEST_ROOT} 0
`;

/**
 * starts the lock owner with fixed minimum ingress and compiled staging frames
 * @param guest exact target guest
 * @param bootstrap whether missing managed Node may be installed
 * @returns private stream and fixed non-secret payload frames
 */
export async function prepareGuestTransaction(
  guest: GuestChannel,
  bootstrap: boolean,
): Promise<{ command: GuestProcess; payloads: string }> {
  const [nodeBootstrap, worker, frame] = await Promise.all([
    readGuestPayload(BOOTSTRAP_MODULE),
    readGuestPayload(WORKER_MODULE),
    guestPayloadFrame(),
  ]);
  checkOperation();
  const command = guest.spawn({
    program: '/bin/sh',
    arguments: [
      '-c',
      launcher,
      'open-agent-transaction',
      bootstrap ? '1' : '0',
    ],
  });

  return {
    command,
    payloads: `begin\n${Buffer.from(nodeBootstrap).toString('base64')}\n${Buffer.from(worker).toString('base64')}\n${frame}\n`,
  };
}
