import { quoteWord } from './session/framing';

import type { StepCommand } from '#application/ports/plan';
import type { GuestAsset } from '#domain/guest';

/** one call of a guest library function: the function, then its arguments */
export type LibraryCall = readonly [string, ...string[]];

/**
 * renders a step command that sources guest libraries and calls their
 * functions in turn, stopping at the first that fails; every word is quoted,
 * so no argument is ever read as shell code
 * @param shell the family's shell
 * @param libraries the libraries to source, in order
 * @param calls the function calls
 * @returns the command, running as the step's account
 * @throws {Error} when no call is given
 */
export function libraryCommand(
  shell: string,
  libraries: readonly GuestAsset[],
  calls: readonly LibraryCall[],
): StepCommand {
  if (calls.length === 0) {
    throw new Error('A library command needs a call');
  }
  const script = [
    ...libraries.map(({ installAs }) => `. ${quoteWord(installAs)}`),
    ...calls.map((call) => call.map(quoteWord).join(' ')),
  ].join(' && ');

  return { argv: [shell, '-c', script] };
}
