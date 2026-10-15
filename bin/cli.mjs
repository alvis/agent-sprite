#!/usr/bin/env -S node --
// "--" ends Node's own options, so Node never claims the CLI's --env-file flag
import { run } from '../lib/cli/index.js';

try {
  await run(process.argv.slice(2));
} catch {
  // the error may carry user input or secrets, so only a generic message is shown
  process.stderr.write('open-agent failed unexpectedly.\n');
  process.exitCode = 1;
}

// exit once output is flushed, so a lingering handle never holds the process open
process.exit();
