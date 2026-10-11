import esm from '@presetter/preset-esm';
import react from '@presetter/preset-react';
import strict from '@presetter/preset-strict';

import globals from 'globals';
import { asset, preset } from 'presetter';

export default preset('agent-sprite', {
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
        'eslint --flag v10_config_lookup_from_file --no-cache --cache-location node_modules/.cache/agent-sprite-lint-check --format stylish --max-warnings 0 --no-error-on-unmatched-pattern --no-warn-ignored {source} {test} bin scripts',
      'lint:check:shell': 'sh -n src/scripts/bootstrap-node.sh',
      'test': 'run-s "test:vitest -- --project=agent-sprite:UNIT {@:}" --',
      'test:coverage': 'vitest run --project=agent-sprite:UNIT --coverage',
    },
    assets: {
      '.gitignore': asset<string[]>((current) => [
        ...(current ?? []),
        '.state/',
      ]),
      'tsconfig.json': asset<{ exclude?: string[] }>((current) => ({
        ...current,
        exclude: [...(current?.exclude ?? []), '.state'],
      })),
      'eslint.config.ts': asset((current) => ({
        ...current,
        default: [
          ...(current?.default ?? []),
          {
            name: 'agent-sprite:lint-cli',
            ignores: ['!bin/'],
          },
          {
            name: 'agent-sprite:type-information',
            languageOptions: {
              parserOptions: {
                project: false,
                projectService: {
                  allowDefaultProject: [
                    'bin/cli.mjs',
                    'scripts/packed-cli.mjs',
                  ],
                },
              },
            },
          },
          {
            name: 'agent-sprite:javascript',
            files: ['bin/**/*.mjs', 'scripts/**/*.mjs'],
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
                  name: 'agent-sprite:UNIT',
                  include: ['spec/**/*.spec.ts', 'spec/**/*.spec.tsx'],
                  exclude: ['spec/e2e/**'],
                  passWithNoTests: false,
                },
              },
              {
                extends: true,
                test: {
                  name: 'agent-sprite:E2E',
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
