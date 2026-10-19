import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { CommandOptions } from '#application/contracts';
import type { resolveInputs } from '#application/input';

interface ResolverCase {
  options: CommandOptions;
  resolution?: NonNullable<
    Parameters<typeof resolveInputs>[1]['requirementSelection']
  >;
  stringCandidate?: string;
}

// Run the real TypeScript source graph in a separate Node process. Source
// relative imports carry no extension, so resolve them to their .ts, .tsx or
// directory index file here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
        const source = new URL(specifier + suffix, context.parentURL);
        if (existsSync(fileURLToPath(source))) {
          return nextResolve(source.href, context);
        }
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
  await import('#application/input');
const { selectGithubToken } = await import('#application/input/github');
const { commandError } = await import('#application/failures');
const { createDependencies } = await import('#composition/dependencies');
const { OperationContext, withOperation } = await import('#kernel/operation');
const dependencies = createDependencies();

/**
 * runs one case within an invocation that reports status as the installed CLI does
 * @param entry the case to resolve
 * @returns the case outcome
 */
async function resolveReporting(entry: ResolverCase) {
  const operation = new OperationContext({
    signal: new AbortController().signal,
    onStatus: (update) => {
      process.stderr.write(`Warning: ${update.message}\n`);
    },
  });

  return withOperation(operation, async () => resolveCase(entry));
}

async function resolveCase(entry: ResolverCase) {
  try {
    if (entry.stringCandidate) {
      const token = await selectGithubToken(
        entry.stringCandidate,
        entry.options,
      );

      return { ok: true, githubToken: token };
    }
    const result = await resolveSourceInputs(dependencies, {
      options: entry.options,
      requirementSelection: entry.resolution,
    });

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
  results.push(await resolveReporting(entry));
}
process.stdout.write(`${JSON.stringify(results)}\n`);
