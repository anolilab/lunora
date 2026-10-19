import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

/**
 * Every `lunora.config.*` path source discovery may read for the schema directory
 * `lunoraDirectory`: each candidate name in its parent and every directory above that,
 * nearest first, up to and including the project root (the first directory holding a
 * `package.json` or `.git`). The schema directory itself is not searched, matching
 * discovery. A config above the root belongs to another project, so the walk stops there.
 *
 * Listed whether or not each file exists. A watcher needs the absent ones too, so
 * that creating a nearer config is seen as the change it is.
 */
const projectConfigCandidatePaths = (lunoraDirectory: string): string[] => {
    const candidates: string[] = [];
    let directory = dirname(resolve(lunoraDirectory));

    for (;;) {
        candidates.push(...PROJECT_CONFIG_FILENAMES.map((name) => join(directory, name)));

        if (existsSync(join(directory, "package.json")) || existsSync(join(directory, ".git"))) {
            return candidates;
        }

        const parent = dirname(directory);

        if (parent === directory) {
            return candidates;
        }

        directory = parent;
    }
};

/** The config codegen reads for `lunoraDirectory`: the nearest existing candidate, or `undefined`. */
const findCodegenConfigFile = (lunoraDirectory: string): string | undefined =>
    projectConfigCandidatePaths(lunoraDirectory).find((candidate) => existsSync(candidate));

export { findCodegenConfigFile, findProjectConfigFile, PROJECT_CONFIG_FILENAMES, projectConfigCandidatePaths };
