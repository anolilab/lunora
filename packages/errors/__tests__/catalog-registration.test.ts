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

// The shapes a Lunora package mints an error code in. Each pattern captures the
// code in group 1; a code found by more than one is deduped by the caller.
//
// Deliberately textual (not AST-based) — this is meant to catch a *future*
// uncatalogued code the same cheap way a reviewer would grep for one. Three
// separate patterns rather than one alternation: the combined form is past the
// regex-complexity budget, and each shape's case rule reads next to it.
//
// A template-literal code (`` `CODE_${x}` ``) is undetectable by a textual gate
// either way — an accepted limitation, not a silent one.
const CODE_PATTERNS: ReadonlyArray<RegExp> = [
    // The `{ code: "X", ... }` structured-error/options shape.
    //
    // SCREAMING_SNAKE_CASE-only: widening it would flag every unrelated
    // `code: "Enter"` (key events), `code: "en"` (locale tags), `code: "P2002"`
    // (driver errors) repo-wide, which is what makes the heuristic viable.
    /code:\s*"([A-Z][A-Z0-9_]*)"/g,

    // A direct `new LunoraError("X", ...)`. Its first argument is unambiguously
    // a code, so any case goes (`badRequest`, `BadRequest`, ...) — a mint
    // doesn't have to be SCREAMING_SNAKE_CASE to reach `isInternalCode`.
    /new LunoraError\(\s*"([A-Za-z]\w*)"/g,

    // An INDIRECT mint: `new <Anything>Error("X", ...)` (a `LunoraError`
    // subclass such as the payment package's), `raise("X", ...)`, and the
    // `super("X", ...)` a subclass constructor forwards with.
    //
    // This is what makes the gate see past the base class. `isInternalCode`
    // keys off the *code*, not the constructor, so a code minted through a
    // subclass reaches the wire mappers exactly like a base-class one — and a
    // pattern pinned to the literal name `LunoraError` classes every subclass
    // mint as unregistered-therefore-client-safe. Six payment codes shipped
    // that way.
    //
    // SCREAMING_SNAKE_CASE-only, because unlike the group above these shapes
    // also take a plain MESSAGE first (`new TypeError("some message")`,
    // `super("message")`) and the case restriction is what tells the two apart.
    /(?:new\s+\w*Error|raise|super)\(\s*"([A-Z][A-Z0-9_]*)"/g,
];

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

            for (const pattern of CODE_PATTERNS) {
                for (const match of content.matchAll(pattern)) {
                    const code = match[1];

                    if (code !== undefined && !catalogKeys.has(code) && !missing.has(code)) {
                        missing.set(code, filePath.replace(`${REPO_ROOT}/`, ""));
                    }
                }
            }
        }

        const unexpected = [...missing.entries()].filter(([code]) => !KNOWN_NON_LUNORA_CODES.has(code));

        expect(
            unexpected.map(([code, file]) => `${code} (first seen in ${file})`),
            "Found error code(s) minted outside ERROR_CATALOG. Register each with a status/title (and internal: true if its message can carry backend detail) in packages/errors/src/catalog.ts.",
        ).toStrictEqual([]);
    });

    // Guards the *scanner*, not the catalog. The repo-wide `it` above only goes
    // red while an uncatalogued code happens to exist, so once the catalog is
    // complete a narrowing of CODE_PATTERN back to the literal `LunoraError`
    // name would land green — and every future subclass mint would again be
    // treated as client-safe by `isInternalCode`.
    it("the scanner sees indirect mints, not just `new LunoraError(...)`", () => {
        expect.assertions(1);

        const source = [
            `throw new SubError("SUBCLASS_MINT", "d");`,
            `raise("RAISE_MINT", "d");`,
            `super("SUPER_MINT", message, { name: "X" });`,
            `new LunoraError("baseMint", "d");`,
            `const options = { code: "OBJECT_MINT" };`,
            // Not codes: a plain message-first construction, and a lowercase
            // `code:` value from an unrelated union.
            `throw new TypeError("expected a string");`,
            `super("plain message");`,
            `const key = { code: "Enter" };`,
        ].join("\n");

        const found = new Set<string>();

        for (const pattern of CODE_PATTERNS) {
            for (const match of source.matchAll(pattern)) {
                found.add(match[1] as string);
            }
        }

        expect([...found].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["baseMint", "OBJECT_MINT", "RAISE_MINT", "SUBCLASS_MINT", "SUPER_MINT"]);
    });

    it("every KNOWN_NON_LUNORA_CODES entry still occurs in its expected file", () => {
        expect.assertions(5);

        for (const [code, relativeFile] of KNOWN_NON_LUNORA_CODES) {
            const content = readFileSync(join(REPO_ROOT, relativeFile), "utf8");

            expect(content, `Expected ${code} to still appear in ${relativeFile} — update or remove the allowlist entry if it moved.`).toContain(`"${code}"`);
        }
    });
});
