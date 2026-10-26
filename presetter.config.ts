import esm from '@presetter/preset-esm';
import react from '@presetter/preset-react';
import strict from '@presetter/preset-strict';

import { preset } from 'presetter';

export default preset('open-agent', {
  extends: [esm, strict, react],
  assets: {
    // guest programs ship as they are, at their install paths
    '.npmignore': ['!/guest/**'],
  },
  override: {
    assets: {
      'vitest.config.ts': {
        default: {
          test: {
            mockReset: true,
            clearMocks: true,
            restoreMocks: true,
            unstubEnvs: true,
            unstubGlobals: true,
          },
        },
      },
    },
  },
});
