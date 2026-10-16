import { cli } from './application';
import { flushOutput } from './streams';

/**
 * runs the CLI for the installed executable and flushes its final output
 * @param argv command-line arguments after the executable name
 */
export async function run(argv: string[]): Promise<void> {
  await cli(argv);
  await flushOutput();
}
