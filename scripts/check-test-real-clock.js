#!/usr/bin/env node
/**
 * Keeps real-clock waits out of unit tests.
 *
 * The repo rule is that tests wait on a milestone, never on a clock: a fixed
 * `sleep(200)` is flaky on a loaded runner or slow everywhere, and "after N ms
 * it was called at most once" only proves nothing happened *yet*. Converting the
 * existing offenders is incremental, so this guard works from a baseline
 * (`test-real-clock.baseline.json`): a test file that sleeps for a real >= 10 ms
 * and is not listed fails the check, and so does a listed file that no longer
 * does, which forces the baseline to shrink as files are converted.
 *
 * Deliberately a regex sweep, not an AST walk: it flags the three spellings the
 * suite actually uses, and the baseline is the worklist for later batches.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(rootDir, "scripts", "test-real-clock.baseline.json");

// A delay of two or more digits, `_` separators allowed (lint requires them from five digits up),
// or a named one (a `settle(ms = 25)` helper); a third argument passes a value to resolve with.
// The third spelling is a timer whose callback does some work and then resolves the awaited promise.
const DELAY = String.raw`(?:[0-9]{2}[0-9_]*|[A-Za-z_$][\w$]*)`;
const PATTERNS = [
    new RegExp(String.raw`sleep\([0-9]{2}[0-9_]*\)`, "u"),
    new RegExp(String.raw`setTimeout\((?:resolve|r), ${DELAY}[,)]`, "u"),
    new RegExp(String.raw`setTimeout\(\(\) => \{[^}]*?\b(?:resolve|r)\([^)]*\);?\s*\},\s*${DELAY}\)`, "su"),
];
const TEST_FILE = /\.test\.tsx?$/u;
const SKIPPED_DIRS = new Set(["dist", "node_modules", "workerd"]);

/** Every test file under `dir`, skipping the `workerd` suites (they run in a real runtime where a clock is the point) and build output. */
const walk = (dir) => {
    const found = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) {
                found.push(...walk(path));
            }
        } else if (TEST_FILE.test(entry.name)) {
            found.push(path);
        }
    }

    return found;
};

const flagged = new Set();

// Whole package and app trees: a test kept beside its source (`src/x.test.ts`) is a test too.
for (const parent of ["apps", "packages"]) {
    for (const entry of readdirSync(join(rootDir, parent), { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }

        for (const path of walk(join(rootDir, parent, entry.name))) {
            const source = readFileSync(path, "utf8");

            if (PATTERNS.some((pattern) => pattern.test(source))) {
                flagged.add(relative(rootDir, path).split("\\").join("/"));
            }
        }
    }
}

const baseline = new Map(JSON.parse(readFileSync(baselinePath, "utf8")).map((entry) => [entry.file, entry.reason]));
const problems = [];

for (const file of [...flagged].sort()) {
    if (!baseline.has(file)) {
        problems.push(
            `${file}: waits on the real clock. Wait on a milestone or inject the clock instead (see "Tests wait on a milestone, never on a clock" in AGENTS.md); if it truly cannot, add it to scripts/test-real-clock.baseline.json with a reason.`,
        );
    }
}

for (const file of baseline.keys()) {
    if (!flagged.has(file)) {
        problems.push(`${file}: no longer waits on the real clock. Remove it from scripts/test-real-clock.baseline.json.`);
    }
}

if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
}

console.log(`check-test-real-clock: ${String(flagged.size)} baselined file(s), no new real-clock waits.`);
