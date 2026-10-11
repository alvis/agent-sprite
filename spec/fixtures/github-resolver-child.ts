import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { CommandOptions } from '../../src/command.js';
import type { resolveInputs } from '../../src/input.js';

interface ResolverCase {
  options: CommandOptions;
  resolution?: NonNullable<Parameters<typeof resolveInputs>[2]>;
  stringCandidate?: string;
}

// Run the real TypeScript source graph in a separate Node process. Source
// relative imports use emitted .js names, so resolve those names to .ts here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(source))) {
        return nextResolve(source.href, context);
      }
    }

    return nextResolve(specifier, context);
  },
});

const scenarioPath = process.argv[2];
if (!scenarioPath) {
  throw new Error('A protected source-resolver scenario is required');
}
const scenario: unknown = JSON.parse(readFileSync(scenarioPath, 'utf8'));
if (
  !scenario ||
  typeof scenario !== 'object' ||
  !('cases' in scenario) ||
  !Array.isArray(scenario.cases)
) {
  throw new Error('Source-resolver scenario must contain cases');
}
const { resolveInputs: resolveSourceInputs } =
  await import('../../src/input.js');
const { selectGithubToken } = await import('../../src/input/github.js');
const { commandError } = await import('../../src/errors.js');

async function resolveCase(entry: ResolverCase) {
  try {
    if (entry.stringCandidate) {
      const token = await selectGithubToken(
        entry.stringCandidate,
        entry.options,
      );

      return { ok: true, githubToken: token };
    }
    const result = await resolveSourceInputs(
      entry.options,
      undefined,
      entry.resolution,
    );

    return {
      ok: true,
      githubToken: result.githubToken,
      gitIdentity: result.gitIdentity,
      missing: result.missing,
    };
  } catch (error) {
    return { ok: false, error: commandError(error) };
  }
}

const results: unknown[] = [];
for (const entry of scenario.cases as ResolverCase[]) {
  results.push(await resolveCase(entry));
}
process.stdout.write(`${JSON.stringify(results)}\n`);
