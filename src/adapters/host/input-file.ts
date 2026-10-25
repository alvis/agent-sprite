import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { CommandFault } from '#kernel/faults';
import { currentOperation, runBoundedIO } from '#kernel/operation';

/**
 * reads regular input files without blocking on a named pipe or device
 * @param path selected environment, profile, or credential file
 * @param operation originating invocation, including pre-workflow mode resolution
 * @returns complete UTF-8 input without logging its contents
 */
export async function readInputFile(
  path: string,
  operation = currentOperation(),
): Promise<string> {
  return (await readInputBytes(path, operation)).toString('utf8');
}

/**
 * reads a regular input file's exact bytes, such as an executable, without
 * blocking on a named pipe or device
 * @param path selected input file
 * @param operation originating invocation, including pre-workflow mode resolution
 * @returns the file's complete contents without logging them
 */
export async function readInputBytes(
  path: string,
  operation = currentOperation(),
): Promise<Buffer> {
  return runBoundedIO(async (signal) => {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      signal?.throwIfAborted();
      const info = await file.stat();
      signal?.throwIfAborted();
      if (!info.isFile()) {
        throw new CommandFault({
          code: 'INPUT',
          message:
            'Selected input must be a regular file; pipes and devices are unsupported.',
        });
      }

      return await file.readFile({ signal });
    } finally {
      await file.close();
    }
  }, operation);
}
