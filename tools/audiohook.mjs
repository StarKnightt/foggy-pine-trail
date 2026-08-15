/* Extensionless resolution for src/audio/*.ts under bare Node.
 *
 * The audio modules import each other the way the rest of the project does —
 * `from './dsp'` — because that is what the bundler wants and what
 * `tsc --noEmit` accepts without `allowImportingTsExtensions`. Node's ESM
 * resolver has no extension search at all, so importing those files directly
 * from a tool fails on the first cross-module import.
 *
 * Writing `./dsp.ts` in the source instead would fix Node and break the type
 * check, and adding the compiler flag would mean editing a tsconfig shared with
 * every other system in the project. A resolver hook keeps the fix entirely
 * inside tools/, where it belongs: this is a property of how the tool loads the
 * code, not of the code.
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      return next(specifier + '.ts', context);
    }
    throw err;
  }
}
