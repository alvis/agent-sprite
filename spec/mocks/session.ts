import { revealSecret } from '#integrations/guest/session/secret';

import type { ProviderDriver } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type {
  GuestSession,
  StepInput,
} from '#integrations/guest/session/contracts';
import type { WorkstationSessionParams } from '#integrations/guest/session/open';
import type { OsRelease } from '#os/contracts';

/** pid the stand-in session reports for its shell */
const SESSION_PID = 4242;
/** the release a stand-in session reports unless told another */
const DEBIAN_RELEASE: OsRelease = {
  family: 'debian',
  id: 'debian',
  versionId: '12',
  codename: 'bookworm',
  arch: 'x86_64',
  libc: 'glibc',
};
/** what the stand-in session names a secret delivered as a file: no file is written, the secret arrives as input */
const SECRET_FILE = 'open-agent-session-secret';

/**
 * stands in for the root setup session over a provider's channel: a spec
 * mocks `#integrations/guest/session/open` with this module, so every
 * session command reaches the provider mock's exec, a secret as its input
 * @param params the provider, workstation and family a session opens with
 * @returns a session whose commands run through the provider's channel
 */
export async function openWorkstationSession(
  params: WorkstationSessionParams,
): Promise<GuestSession> {
  const { provider, workstation, family } = params;
  const [image] = provider.images;
  if (!opensGuest(provider)) {
    throw new Error('The stand-in session needs a provider that opens a guest');
  }

  return standInSession(await provider.openGuest(workstation), {
    family: family.id,
    id: image.release?.id ?? 'debian',
    versionId: image.release?.versionId ?? '12',
    codename: 'bookworm',
    arch: image.arch[0],
    libc: 'glibc',
  });
}

/**
 * stands in for a root setup session over a guest channel
 * @param channel the channel every session command runs through
 * @param release what the session reports the guest to be
 * @returns a session whose commands reach the channel's exec, a secret as its input
 */
export function standInSession(
  channel: GuestChannel,
  release: OsRelease = DEBIAN_RELEASE,
): GuestSession {
  return {
    release,
    pid: SESSION_PID,
    run: async (command) => {
      const [program, ...rest] = command.argv;

      return channel.exec({
        program,
        arguments: rest,
        account: command.account === 'agent' ? 'agent' : 'root',
        timeoutMs: command.timeoutMs,
        ...secretEnvironment(command.input, command.environment),
        ...inputOf(command.input),
      });
    },
    [Symbol.asyncDispose]: async () => undefined,
  };
}

/**
 * names the secret file in the environment of a command given one
 * @param input the command's standard input
 * @param environment the command's own variables
 * @returns the environment the channel runs the command with
 */
function secretEnvironment(
  input: StepInput | undefined,
  environment: Readonly<Record<string, string>> | undefined,
): Pick<Parameters<GuestChannel['exec']>[0], 'environment'> {
  const named =
    input?.kind === 'secret' && input.as === 'shm-file'
      ? { OPEN_AGENT_SECRET_FILE: SECRET_FILE }
      : undefined;

  return environment || named
    ? { environment: { ...environment, ...named } }
    : {};
}

/**
 * tells whether the provider a session opens with also opens its channel
 * @param provider the provider the connection holds
 * @returns true when it opens the guest channel
 */
function opensGuest(
  provider: WorkstationSessionParams['provider'],
): provider is WorkstationSessionParams['provider'] &
  Pick<ProviderDriver, 'openGuest'> {
  return 'openGuest' in provider;
}

/**
 * hands a session input to the channel as its standard input
 * @param input the command's standard input
 * @returns the channel input, a secret's value included
 */
function inputOf(
  input: StepInput | undefined,
): Pick<Parameters<GuestChannel['exec']>[0], 'input'> {
  switch (input?.kind) {
    case 'text':
      return { input: input.value };
    case 'bytes':
      return { input: Buffer.from(input.value).toString('utf8') };
    case 'secret':
      return { input: revealSecret(input.value) };
    default:
      return {};
  }
}
