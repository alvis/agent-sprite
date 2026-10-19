import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import process from 'node:process';

/**
 * locates an executable on PATH without running it
 * @param command executable name
 * @returns the absolute path, or undefined when no PATH entry has it
 */
export async function findTool(command: string): Promise<string | undefined> {
  const candidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, command));
  const found = await Promise.all(
    candidates.map(async (path) =>
      access(path, constants.X_OK).then(
        () => path,
        () => undefined,
      ),
    ),
  );

  return found.find((path) => path !== undefined);
}
