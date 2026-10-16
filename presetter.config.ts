import esm from '@presetter/preset-esm';
import react from '@presetter/preset-react';
import strict from '@presetter/preset-strict';

import globals from 'globals';
import { asset, preset } from 'presetter';

export default preset('open-agent', {
  extends: [esm, strict, react],
  override: {
    scripts: {
      'lint':
        'run-s "lint:prettier -- {@:{source} {test}}" "lint:eslint -- {@:{source} {test}}" "lint:fixme -- {@:{source} {test}}" --',
      'lint:check':
        'run-s lint:check:prettier lint:check:eslint lint:check:shell',
      'lint:check:prettier':
        'prettier --check --no-error-on-unmatched-pattern {source} {test} bin scripts',
      'lint:check:eslint':
        'eslint --flag v10_config_lookup_from_file --no-cache --cache-location node_modules/.cache/open-agent-lint-check --format stylish --max-warnings 0 --no-error-on-unmatched-pattern --no-warn-ignored {source} {test} bin scripts',
      'lint:check:shell':
        "find guest -name '*.sh' -exec sh -c 'for f; do sh -n \"$f\" || exit 1; done' sh {} + && find guest -name '*.sh' -exec shellcheck --shell=sh --severity=style {} +",
      'test': 'run-s "test:vitest -- --project=open-agent:UNIT {@:}" --',
      'test:coverage': 'vitest run --project=open-agent:UNIT --coverage',
    },
    assets: {
      // guest programs ship as they are, at their install paths
      '.npmignore': asset<string[]>((current) => [
        ...(current ?? []),
        '!/guest/**',
      ]),
      'eslint.config.ts': asset((current) => ({
        ...current,
        default: [
          ...(current?.default ?? []),
          {
            name: 'open-agent:lint-cli',
            ignores: ['!bin/'],
          },
          {
            name: 'open-agent:type-information',
            languageOptions: {
              parserOptions: {
                project: false,
                projectService: {
                  allowDefaultProject: ['bin/cli.mjs'],
                },
              },
            },
          },
          {
            name: 'open-agent:javascript',
            files: ['bin/**/*.mjs'],
            languageOptions: {
              globals: globals.node,
            },
          },
        ],
      })),
      'vitest.config.ts': asset<{
        default?: { test?: Record<string, unknown> };
      }>((current) => ({
        ...current,
        default: {
          ...current?.default,
          test: {
            ...current?.default?.test,
            clearMocks: true,
            mockReset: true,
            restoreMocks: true,
            unstubEnvs: true,
            unstubGlobals: true,
            passWithNoTests: false,
            projects: [
              {
                extends: true,
                test: {
                  name: 'open-agent:UNIT',
                  include: ['spec/**/*.spec.ts', 'spec/**/*.spec.tsx'],
                  exclude: ['spec/e2e/**', 'spec/live/**/*.spec.live.ts'],
                  passWithNoTests: false,
                },
              },
              {
                extends: true,
                test: {
                  name: 'open-agent:LIVE',
                  include: ['spec/live/**/*.spec.live.ts'],
                  // the Fly Machine probe is its own project: pnpm test:live:fly
                  exclude: ['spec/live/fly-machine.spec.live.ts'],
                  globalSetup: ['spec/live/setup.ts'],
                  coverage: { enabled: false },
                  fileParallelism: false,
                  testTimeout: 5_400_000, // 90 minutes; one real creation can exceed 10 minutes
                  passWithNoTests: false,
                },
              },
              {
                extends: true,
                test: {
                  name: 'open-agent:LIVE-FLY',
                  include: ['spec/live/fly-machine.spec.live.ts'],
                  globalSetup: ['spec/live/setup.ts'],
                  coverage: { enabled: false },
                  fileParallelism: false,
                  testTimeout: 1_800_000, // 30 minutes; one probe creates, serves and deletes a machine
                  passWithNoTests: false,
                },
              },
              {
                extends: true,
                test: {
                  name: 'open-agent:E2E',
                  include: ['spec/e2e/**/*.spec.e2e.ts'],
                  coverage: { enabled: false },
                  passWithNoTests: false,
                },
              },
            ],
          },
        },
      })),
    },
  },
});
