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
    },
  },
});
