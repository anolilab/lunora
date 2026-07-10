import { join } from "node:path";

/**
 * Expand a Nuxt `~`/`~~` tilde or a relative (`./`, `../`) specifier to an
 * absolute path. `~/` is the project srcDir, `~~/` the rootDir; a relative
 * specifier is resolved against the rootDir. A bare package specifier or an
 * already-absolute path is returned untouched.
 *
 * Used for the `#lunora/app` alias, which the Nitro server bundle consumes: Nitro
 * re-resolves a non-absolute alias target against its OWN srcDir (the `server/`
 * dir), so `~/lunora/server` — or a relative `./lunora/server` — would wrongly
 * land at `server/...` and abort the build. An absolute path resolves identically
 * in the Nuxt and Nitro graphs. Relative specifiers can never be npm package
 * names, so resolving them against rootDir is unambiguous.
 */
const resolveTildePath = (specifier: string, rootDirectory: string, sourceDirectory: string): string => {
    if (specifier.startsWith("~~/")) {
        return join(rootDirectory, specifier.slice(3));
    }

    if (specifier.startsWith("~/")) {
        return join(sourceDirectory, specifier.slice(2));
    }

    if (specifier.startsWith("./") || specifier.startsWith("../")) {
        return join(rootDirectory, specifier);
    }

    return specifier;
};

export { resolveTildePath };
