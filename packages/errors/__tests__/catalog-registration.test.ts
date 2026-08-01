import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ERROR_CATALOG } from "../src";

// Repo root, three levels up from packages/errors/__tests__.
const REPO_ROOT = join(__dirname, "..", "..", "..");
const PACKAGES_ROOT = join(REPO_ROOT, "packages");

const SKIP_DIRECTORIES = new Set([
    ".git",
    ".history",
    ".vis",
    ".wrangler",
    "__fixtures__",
    "__tests__",
    "coverage",
    "dist",
    "fixtures",
    "node_modules",
    "test-results",
]);

// Matches the two shapes a Lunora package mints an error code in: the
// `{ code: "X", ... }` structured-error/options shape, and a direct
// `new LunoraError("X", ...)` first-argument literal. Deliberately textual
// (not AST-based) — this is meant to catch a *future* uncatalogued code the
// same cheap way a reviewer would grep for one.
const CODE_PATTERN = /code:\s*"([A-Z][A-Z0-9_]*)"|new LunoraError\(\s*"([A-Z][A-Z0-9_]*)"/g;

/** Recursively collect `.ts`/`.tsx` source files under `dir`, skipping build/vendor/test directories. */
const collectSourceFiles = (dir: string): string[] => {
    const entries = readdirSync(dir);
    const files: string[] = [];

    for (const entry of entries) {
        if (SKIP_DIRECTORIES.has(entry)) {
            continue;
        }

        const fullPath = join(dir, entry);
        const stats = statSync(fullPath);

        /* eslint-disable vitest/no-conditional-tests -- filesystem walk, not a test-behavior branch; the file-type check is inherent to recursing a directory tree */
        if (stats.isDirectory()) {
            files.push(...collectSourceFiles(fullPath));
        } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
            files.push(fullPath);
        }
        /* eslint-enable vitest/no-conditional-tests */
    }

    return files;
};

/** Every `packages/&lt;name>/src` directory in the monorepo. */
const packageSourceDirs = (): string[] => {
    const dirs: string[] = [];

    for (const packageDirectory of readdirSync(PACKAGES_ROOT)) {
        const srcDir = join(PACKAGES_ROOT, packageDirectory, "src");

        try {
            if (statSync(srcDir).isDirectory()) {
                dirs.push(srcDir);
            }
        } catch {
            // No src/ directory for this package — nothing to scan.
        }
    }

    return dirs;
};

describe("error catalog registration", () => {
    it("every minted SCREAMING_SNAKE_CASE error code across packages/*/src is a catalog key", () => {
        expect.assertions(1);

        const catalogKeys = new Set(Object.keys(ERROR_CATALOG));
        const missing = new Map<string, string>();

        for (const srcDir of packageSourceDirs()) {
            for (const filePath of collectSourceFiles(srcDir)) {
                const content = readFileSync(filePath, "utf8");

                for (const match of content.matchAll(CODE_PATTERN)) {
                    const code = match[1] ?? match[2];

                    if (code !== undefined && !catalogKeys.has(code) && !missing.has(code)) {
                        missing.set(code, filePath.replace(`${REPO_ROOT}/`, ""));
                    }
                }
            }
        }

        expect(
            [...missing.entries()].map(([code, file]) => `${code} (first seen in ${file})`),
            "Found error code(s) minted outside ERROR_CATALOG. Register each with a status/title (and internal: true if its message can carry backend detail) in packages/errors/src/catalog.ts.",
        ).toStrictEqual([]);
    });
});
