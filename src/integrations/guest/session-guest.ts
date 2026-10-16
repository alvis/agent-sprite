import { SERVICE_BACKENDS } from '#services/backends';

import type { ProviderDeclaration } from '#drivers/contracts';
import type {
  GuestChannel,
  GuestCommand,
  GuestExecResult,
  GuestProcess,
  GuestServiceControl,
} from '#drivers/guest-channel';

import type { GuestSession, StepInput } from './session/contracts.js';

/** limit of a channel command run over the session without one of its own */
const DEFAULT_LIMIT_MS = 600_000;

/** a guest channel whose commands run as framed commands of a root setup session */
export interface SessionGuest extends GuestChannel {
  /** the root session every command runs in */
  readonly session: GuestSession;
}

/**
 * runs a guest channel over a root setup session: commands become framed
 * session commands, and the services are controlled by the provider's
 * backend through the session, or by the provider itself where it runs them;
 * reads, existence checks, spawning and the network check stay with the
 * provider's channel, so a file read back is never redacted of a credential
 * this run delivered
 * @param session the root session commands run in
 * @param channel the provider's channel, which reads, spawns and checks the network
 * @param provider the provider, whose service backend controls the services
 * @returns the channel
 */
export function sessionGuest(
  session: GuestSession,
  channel: GuestChannel,
  provider: Pick<ProviderDeclaration, 'serviceBackend'>,
): SessionGuest {
  const services: GuestServiceControl =
    provider.serviceBackend === 'provider'
      ? channel.services
      : SERVICE_BACKENDS[provider.serviceBackend].control(session);
  const exec = async (command: GuestCommand): Promise<GuestExecResult> =>
    session.run({
      argv: [command.program, ...command.arguments],
      account: command.account ?? 'root',
      timeoutMs: command.timeoutMs ?? DEFAULT_LIMIT_MS,
      ...(command.environment ? { environment: command.environment } : {}),
      ...(command.input === undefined
        ? {}
        : { input: { kind: 'text', value: command.input } }),
    });

  return {
    session,
    services,
    exec,
    spawn: (command: GuestCommand): GuestProcess => channel.spawn(command),
    exists: async (path) => channel.exists(path),
    read: async (path) => channel.read(path),
    assertUnrestrictedNetwork: async () => channel.assertUnrestrictedNetwork(),
  };
}

/**
 * tells whether a guest channel runs over a root setup session
 * @param guest the channel
 * @returns true for a channel {@link sessionGuest} made
 */
export function isSessionGuest(guest: GuestChannel): guest is SessionGuest {
  return 'session' in guest;
}

/**
 * runs one command over a channel's setup session with an input only a
 * session can carry, such as a secret
 * @param guest the channel, which must run over a session
 * @param command the command and its account and limit
 * @param input stdin delivered through the session, such as a secret
 * @returns its exit status and redacted output
 * @throws {Error} when the channel runs over no session
 */
export async function runSessionCommand(
  guest: GuestChannel,
  command: Omit<GuestCommand, 'input'>,
  input: StepInput,
): Promise<GuestExecResult> {
  if (!isSessionGuest(guest)) {
    throw new Error(`${command.program} needs a setup session for its input`);
  }

  return guest.session.run({
    argv: [command.program, ...command.arguments],
    account: command.account ?? 'root',
    timeoutMs: command.timeoutMs ?? DEFAULT_LIMIT_MS,
    ...(command.environment ? { environment: command.environment } : {}),
    input,
  });
}
