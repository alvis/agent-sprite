#!/usr/bin/env node

const arguments_ = process.argv.slice(2);
const loaded = await Promise.all([
  import('../lib/cli/application.js'),
  import('../lib/cli/streams.js'),
]).catch(() => undefined);

if (!loaded) {
  const command = [
    'create',
    'setup',
    'list',
    'show',
    'terminate',
    'doctor',
  ].includes(arguments_[0])
    ? arguments_[0]
    : null;
  const json = arguments_.includes('--json');
  const message = 'The command could not start.';
  const stream = json ? process.stdout : process.stderr;
  const output = json
    ? `${JSON.stringify({ schemaVersion: 1, command, ok: false, error: { code: 'UNEXPECTED', message } })}\n`
    : `${message}\n`;
  process.exitCode = 1;
  await new Promise((resolve) => stream.write(output, resolve));
  process.exit();
}

const [{ cli }, { flushOutput }] = loaded;
try {
  await cli(arguments_);
  await flushOutput();
} catch {
  process.stderr.write('agent-sprite failed unexpectedly.\n');
  process.exitCode = 1;
}

process.exit();
