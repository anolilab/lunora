import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The config filenames probed at the project root, in order. TypeScript first
 * because that is what the templates ship and what the type-only `satisfies`
 * needs; the JS forms are accepted so a JS-authored project is not forced into
 * TypeScript for one file.
 *
 * The one exported truth: the dev server watches exactly these, and
 * {@link findProjectConfigFile} probes exactly these.
 *
 * A leaf module (no codegen imports) so discovery can find the config file
 * without importing `project-config-file`, which imports discovery helpers.
 *
 * `.cts` / `.cjs` are absent deliberately. Vite's default `resolve.extensions`
 * does not include them, so the specifier `@lunora/vite` emits for the `app`
 * hook would not resolve — and a config half of whose keys work is worse than
 * one the probe never finds.
 */
const PROJECT_CONFIG_FILENAMES: ReadonlyArray<string> = ["lunora.config.ts", "lunora.config.mts", "lunora.config.js", "lunora.config.mjs"];

/** The resolved config file, or `undefined` when the project ships none. */
const findProjectConfigFile = (projectRoot: string): string | undefined =>
    // `resolve`, not `join`: `jiti` cannot load a relative specifier, while the
    // parser reads one fine — so a relative `projectRoot` made the two readers
    // disagree about a config that was right there.
    PROJECT_CONFIG_FILENAMES.map((name) => resolve(projectRoot, name)).find((candidate) => existsSync(candidate));

export { findProjectConfigFile, PROJECT_CONFIG_FILENAMES };
