/** scheduling mode for one update */
export interface UpdateOptions {
  force: boolean;
}

const updaterArgumentCount = 2;
const forcedUpdateArgumentCount = 3;

/**
 * derives the scheduling mode from the process arguments
 * @param argv process arguments
 * @returns update mode
 */
export function updateOptions(argv: readonly string[]): UpdateOptions {
  if (
    argv.length !== updaterArgumentCount &&
    (argv.length !== forcedUpdateArgumentCount || argv[2] !== '--force')
  ) {
    throw new Error('Invalid managed updater arguments');
  }

  return { force: argv.length === forcedUpdateArgumentCount };
}
