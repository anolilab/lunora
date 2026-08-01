import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Suffix a discoverable eval fixture file must end in. */
const EVAL_FILE_SUFFIX = ".eval.ts";

/** Directories never descended into while discovering eval files. */
const SKIP_DIRECTORIES = new Set([".git", "_generated", "dist", "node_modules"]);

/**
 * Recursively collect `*.eval.ts` files under `directory`, sorted for a
 * deterministic run order. Mirrors codegen's `listLunoraSourceFiles`
 * (`packages/codegen/src/discover-functions.ts`): `lstatSync`, never
 * `statSync`, so a directory symlink pointing at an ancestor is classified by
 * the link itself and never descended into — no symlink-cycle infinite
 * recursion. A missing `directory` yields `[]` rather than throwing, so an
 * app with no `evals/` yet is a no-op, not an error.
 */
const discoverEvalFiles = (directory: string, accumulator: string[] = []): string[] => {
    let entries: string[];

    try {
        entries = readdirSync(directory);
    } catch {
        return accumulator;
    }

    for (const entry of entries) {
        const full = join(directory, entry);
        const info = lstatSync(full);

        if (info.isDirectory()) {
            if (SKIP_DIRECTORIES.has(entry)) {
                continue;
            }

            discoverEvalFiles(full, accumulator);
        } else if (info.isFile() && entry.endsWith(EVAL_FILE_SUFFIX)) {
            accumulator.push(full);
        }
    }

    return accumulator.toSorted((a, b) => a.localeCompare(b));
};

export { discoverEvalFiles, EVAL_FILE_SUFFIX };
