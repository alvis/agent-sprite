import { cli } from './application.js';
import { flushOutput } from './streams.js';

/**
 * runs the CLI for the installed executable and flushes its final output
 * @param argv command-line arguments after the executable name
 */
export async function run(argv: string[]): Promise<void> {
  await cli(argv);
  await flushOutput();
}
