/**
 * Fails when any `package.json` key order drifts from the canonical order that
 * `vis sort-package-json` produces.
 *
 * This mirrors the "Lint (package.json sort)" CI job, which is otherwise
 * unreachable locally: none of the other lint targets look at key order, so a
 * hand-placed block (e.g. `peerDependencies` written above `devDependencies`
 * instead of below it) passes ESLint, Prettier, tsc, and the API/dist snapshots
 * and only fails after a push.
 *
 * Two deliberate differences from the CI job:
 *
 * 1. CI runs the sorter and gates on a leftover `git diff`, because it works on
 *    a clean checkout. Locally that would both rewrite the contributor's tree
 *    and report a false failure whenever an unrelated `package.json` edit is
 *    already uncommitted. So this script snapshots the files, runs the sorter,
 *    compares, then restores whatever it touched — the check is read-only.
 * 2. Detection is content-based rather than git-based, so it also catches drift
 *    in a manifest that is already staged or committed.
 *
 * Scope matches CI: tracked files only. `git diff` cannot see an untracked
 * manifest either, so an unsorted brand-new package is caught by the sort job
 * on the commit that adds it, not before.
 *
 * Run via `pnpm run lint:package-json` (autofix: `pnpm run lint:package-json:fix`).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const run = (command, arguments_) => spawnSync(command, arguments_, { cwd: rootDir, encoding: "utf8" });

const tracked = run("git", ["ls-files", "-z", "*package.json"]);

if (tracked.status !== 0) {
    console.error("❌ Could not list tracked package.json files.");
    console.error(tracked.stderr?.trim() ?? "");

    process.exit(1);
}

const manifestPaths = tracked.stdout.split("\0").filter((path) => path !== "" && !path.includes("node_modules/"));

/** Original bytes, so a drifted file can be put back after the probe. */
const before = new Map();

for (const path of manifestPaths) {
    try {
        before.set(path, readFileSync(join(rootDir, path), "utf8"));
    } catch {
        // A tracked-but-absent path (mid-rebase, sparse checkout) is not our concern.
    }
}

// The sorter writes in place and exits 0 even when it changed something, which
// is exactly why the CI job needs a diff gate rather than an exit code.
const sorted = run("pnpm", ["exec", "vis", "sort-package-json"]);

if (sorted.status !== 0) {
    console.error("❌ `vis sort-package-json` failed to run.");
    console.error((sorted.stderr || sorted.stdout || "").trim());

    process.exit(1);
}

const drifted = [];

for (const [path, original] of before) {
    const absolutePath = join(rootDir, path);

    let current;

    try {
        current = readFileSync(absolutePath, "utf8");
    } catch {
        continue;
    }

    if (current !== original) {
        drifted.push(path);

        // Leave the tree as we found it — this target is a check, not a fixer.
        writeFileSync(absolutePath, original);
    }
}

if (drifted.length > 0) {
    console.error(`❌ ${drifted.length} package.json file(s) are not in canonical key order:`);

    for (const path of drifted) {
        console.error(`   ${path}`);
    }

    console.error("");
    console.error("   Fix with: pnpm run lint:package-json:fix");

    process.exit(1);
}

console.log(`✅ ${before.size} package.json files are in canonical key order.`);
