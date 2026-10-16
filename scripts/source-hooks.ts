import { registerHooks } from 'node:module';

/*
 * resolves the extensionless relative specifiers of the source graph (and the
 * `.js` names of scripts) to their `.ts`, `.tsx` or directory index files so
 * the packed runner can read the source catalog and its sibling modules
 * before any build; load with `node --import ./scripts/source-hooks.ts`
 */
const SOURCE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

registerHooks({
  resolve: (specifier, context, nextResolve) => {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.')) {
        throw error;
      }

      const base = specifier.replace(/\.js$/, '');
      for (const suffix of SOURCE_SUFFIXES) {
        try {
          return nextResolve(base + suffix, context);
        } catch {
          // try the next candidate
        }
      }

      throw error;
    }
  },
});
