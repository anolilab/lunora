import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ERROR_CATALOG } from "../src";

// Repo root, three levels up from packages/errors/__tests__.
const REPO_ROOT = join(__dirname, "..", "..", "..");

// Walked from REPO_ROOT (not just packages/*/src) so registry/, shared/,
// templates/, sdks/, protocol/, tools/, apps/, and examples/ are covered too —
// an unregistered code is treated as client-safe (see isInternalCode below),
// and registry/templates/examples are precisely the code users copy into
// their own apps. Extend this set, don't reintroduce a directory allowlist,
// when a root walk turns up a new build/vendor tree that is noise-only.
const SKIP_DIRECTORIES = new Set([
    // Agent scratch space, and the second place git worktrees are checked out
    // (`git worktree list` shows both `.claude/worktrees/*` and `.worktrees/*`).
    // A worktree is a whole other branch's checkout of this same repo, so
    // walking one makes a code minted on a sibling branch fail THIS branch's
    // gate — locally only, since CI checks out one branch. Skipping `.claude`
    // drops 12,312 of the 15,344 files this walk used to read.
    ".claude",
    ".git",
    ".history",
    ".vis",
    ".worktrees",
    ".wrangler",
    "__fixtures__",
    "__tests__",
    "_generated",
    "api-snapshots",
    "coverage",
    "dist",
    "fixtures",
    "node_modules",
    "patches",
    "test-results",
]);

// Matches the two shapes a Lunora package mints an error code in: the
// `{ code: "X", ... }` structured-error/options shape, and a direct
// `new LunoraError("X", ...)` first-argument literal. Deliberately textual
// (not AST-based) — this is meant to catch a *future* uncatalogued code the
// same cheap way a reviewer would grep for one.
//
// The `new LunoraError(...)` group's first argument is unambiguously a code,
// so it tolerates any case (`badRequest`, `BadRequest`, ...) — a mint doesn't
// have to be SCREAMING_SNAKE_CASE to reach `isInternalCode`. The `code:`
// object-literal group stays SCREAMING_SNAKE_CASE-only: widening it the same
// way would flag every unrelated `code: "Enter"` (key events), `code: "en"`
// (locale tags), `code: "P2002"` (driver errors), and similar repo-wide,
// which is what makes the textual heuristic viable at all. A template-literal
// code (`` `CODE_${x}` ``) is undetectable by a textual gate either way — an
// accepted limitation, not a silent one.
const CODE_PATTERN = /code:\s*"([A-Z][A-Z0-9_]*)"|new LunoraError\(\s*"([A-Za-z]\w*)"/g;

/**
 * Codes the gate would otherwise flag as unregistered but that are not
 * `LunoraError` codes at all — plain `{ code: "X", ... }` literals belonging to
 * an unrelated, non-catalog code union. Registering them in `ERROR_CATALOG`
 * would misstate the catalog's domain (it documents `LunoraError` wire
 * behaviour, and these never reach `isInternalCode`/`toErrorBody`).
 *
 * Each entry is asserted to still occur in its named file (see the integrity
 * `it` below) so the allowlist cannot rot into covering something new once the
 * original site is edited or removed.
 */
const KNOWN_NON_LUNORA_CODES = new Map<string, string>([
    // A hand-rolled `Response.json(...)` error body for an oversized upload,
    // never a `LunoraError` construction.
    ["REQUEST_ENTITY_TOO_LARGE", "packages/storage/src/upload-handler.ts"],
    // `SqlRejectionCode` rejection *values* returned by the read-only SQL
    // classifier — the module docstring is explicit that it returns a
    // rejection value rather than throwing; callers add their own error type.
    // Never a `LunoraError` construction.
    ["SQL_EMPTY", "shared/sql-readonly.ts"],
    ["SQL_MULTIPLE_STATEMENTS", "shared/sql-readonly.ts"],
    ["SQL_NOT_READONLY", "shared/sql-readonly.ts"],
    // `fanSubscriptionError`'s callback payload — a plain object, never a
    // `LunoraError` construction.
    ["SUBSCRIPTION_CANCELLED", "packages/client/src/lunora-client.ts"],
]);

// `@visulima/task-runner`'s build-cache restore materializes a cached `dist`
// at a sibling `<pkg>/dist.restoring-<hash>` path before atomically renaming
// it onto the real `dist` (also `.old-`/`.trash-`/`.failed-` at other points
// in the swap) — a transient directory name never equal to the plain "dist"
// already in SKIP_DIRECTORIES. Running this repo-wide walk alongside CI's
// parallel build-cache activity for dozens of other packages can catch one
// of these mid-swap.
const TRANSIENT_BUILD_CACHE_DIR = /\.(?:restoring|old|trash|failed)-/u;

/** True for a filesystem race — the entry existed at `readdirSync` time but is gone by the time it's inspected. */
const isMissingEntry = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

/** Recursively collect `.ts`/`.tsx` source files under `dir`, skipping build/vendor/test directories. */
const collectSourceFiles = (dir: string): string[] => {
    let entries: string[];

    try {
        entries = readdirSync(dir);
    } catch (error) {
        // `dir` itself was a transient build-cache directory that finished its
        // rename/removal between the parent's readdirSync and this recursive
        // call — nothing to walk, not a real gap in the codebase.
        if (isMissingEntry(error)) {
            return [];
        }

        throw error;
    }

    const files: string[] = [];

    /* eslint-disable vitest/no-conditional-tests -- filesystem walk, not a test-behavior branch; every branch below (the skip-list check, the transient-directory check, the file-type check) is inherent to recursing a directory tree */
    for (const entry of entries) {
        if (SKIP_DIRECTORIES.has(entry) || TRANSIENT_BUILD_CACHE_DIR.test(entry)) {
            continue;
        }

        const fullPath = join(dir, entry);

        let stats;

        try {
            stats = statSync(fullPath);
        } catch (error) {
            // Same race as above, one level up: the entry vanished between this
            // directory's readdirSync and the stat of one of its children.
            if (isMissingEntry(error)) {
                continue;
            }

            throw error;
        }

        if (stats.isDirectory()) {
            files.push(...collectSourceFiles(fullPath));
        } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
            files.push(fullPath);
        }
    }
    /* eslint-enable vitest/no-conditional-tests */

    return files;
};

describe("error catalog registration", () => {
    it("every minted error code across the whole repo is a catalog key", () => {
        expect.assertions(1);

        const catalogKeys = new Set(Object.keys(ERROR_CATALOG));
        const missing = new Map<string, string>();

        for (const filePath of collectSourceFiles(REPO_ROOT)) {
            const content = readFileSync(filePath, "utf8");

            for (const match of content.matchAll(CODE_PATTERN)) {
                const code = match[1] ?? match[2];

                if (code !== undefined && !catalogKeys.has(code) && !missing.has(code)) {
                    missing.set(code, filePath.replace(`${REPO_ROOT}/`, ""));
                }
            }
        }

        const unexpected = [...missing.entries()].filter(([code]) => !KNOWN_NON_LUNORA_CODES.has(code));

        expect(
            unexpected.map(([code, file]) => `${code} (first seen in ${file})`),
            "Found error code(s) minted outside ERROR_CATALOG. Register each with a status/title (and internal: true if its message can carry backend detail) in packages/errors/src/catalog.ts.",
        ).toStrictEqual([]);
    });

    it("every KNOWN_NON_LUNORA_CODES entry still occurs in its expected file", () => {
        expect.assertions(5);

        for (const [code, relativeFile] of KNOWN_NON_LUNORA_CODES) {
            const content = readFileSync(join(REPO_ROOT, relativeFile), "utf8");

            expect(content, `Expected ${code} to still appear in ${relativeFile} — update or remove the allowlist entry if it moved.`).toContain(`"${code}"`);
        }
    });
});
