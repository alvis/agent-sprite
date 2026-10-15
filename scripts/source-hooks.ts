import { registerHooks } from 'node:module';

/*
 * maps source `.js` specifiers to their `.ts` files so the packed runner can
 * read the source catalog and its sibling modules before any build; load with
 * `node --import ./scripts/source-hooks.ts`
 */
registerHooks({
  resolve: (specifier, context, nextResolve) => {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.endsWith('.js')) {
        throw error;
      }

      return nextResolve(specifier.replace(/\.js$/, '.ts'), context);
    }
  },
});
