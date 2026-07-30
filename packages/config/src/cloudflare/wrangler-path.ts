/**
 * Canonical wrangler-config location + read helpers, shared by the validator,
 * the binding inference/reconciliation, and `@lunora/vite`'s cron sync so the
 * probe order and JSONC-parse boilerplate live in exactly one place.
 */
import { existsSync, readFileSync } from "node:fs";

import type { ParseError } from "jsonc-parser";
import { parse as parseJsonc } from "jsonc-parser";

import join from "../path";

/** Candidate wrangler config filenames, in the order every consumer probes them. */
const WRANGLER_FILES = ["wrangler.jsonc", "wrangler.json"] as const;

/** Locate the project's wrangler config, or `undefined` when none exists. */
const findWranglerFile = (projectRoot: string): string | undefined => {
    for (const candidate of WRANGLER_FILES) {
        const fullPath = join(projectRoot, candidate);

        if (existsSync(fullPath)) {
            return fullPath;
        }
    }

    return undefined;
};

interface ReadWranglerResult<T> {
    /** Parsed config, or `undefined` when the file was not valid JSONC. */
    parsed: T | undefined;
    /** Raw file text — needed for comment-preserving `modify`/`applyEdits`. */
    text: string;
}

/**
 * Read and JSONC-parse a wrangler config file. Returns the raw `text` (for
 * structural edits) alongside `parsed`, which is `undefined` when the file is
 * not valid JSONC or does not parse to an object. Allows trailing commas, as
 * wrangler does.
 */
const readWranglerJsonc = <T = unknown>(wranglerPath: string): ReadWranglerResult<T> => {
    const text = readFileSync(wranglerPath, "utf8");
    const parseErrors: ParseError[] = [];
    const value: unknown = parseJsonc(text, parseErrors, { allowTrailingComma: true });

    if (parseErrors.length > 0 || value === null || typeof value !== "object") {
        return { parsed: undefined, text };
    }

    return { parsed: value as T, text };
};

export type { ReadWranglerResult };
export { findWranglerFile, readWranglerJsonc, WRANGLER_FILES };
