/**
 * Guards against a committed generator output going stale.
 *
 * Several files in this repo are written by a script and committed:
 * `labeler-config.yml`, each package's `__assets__/package-og.svg` + README block,
 * and `apps/docs/src/data/packages.ts`. Nothing re-ran the generators in CI and
 * compared, so a committed output could drift from what the generator produces
 * and no gate noticed.
 *
 * It had. `apps/docs/src/data/packages.ts` listed 51 packages against the
 * generator's 52 — `@lunora/platform-node` was missing entirely — and the drift
 * was masked because `apps/docs`'s `build` runs the generator as its first step,
 * so every local build silently rewrote the file (unformatted, since the
 * generator did not run Prettier) and every developer learned to ignore it.
 *
 * Rather than `git diff --exit-code` over the whole tree — which is right in CI
 * but fails locally on any unrelated edit you happen to have — this snapshots the
 * working tree's dirty set BEFORE running the generators and compares it AFTER.
 * Only paths the generators actually touched are reported, so the check is
 * runnable mid-change and stays correct without a hand-maintained list of output
 * paths (a generator added later is covered automatically).
 *
 * Run: node scripts/check-generated-files.mjs
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The generators that own a committed file, in the order postinstall/build run them. */
const GENERATORS = [
    ["node", ["scripts/generate-labeler-config.js", "--skip-ci"]],
    ["node", ["scripts/generate-package-og-images.js"]],
    ["node", ["apps/docs/scripts/generate-packages.js"]],
];

/** `path -> status` for every file git considers dirty (modified, added, untracked, …). */
const dirtySet = () => {
    const raw = execFileSync("git", ["status", "--porcelain=v1"], { cwd: rootDir, encoding: "utf8" });
    const entries = new Map();

    for (const line of raw.split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        // `XY <path>` — the status code is the first two columns.
        entries.set(line.slice(3).trim(), line.slice(0, 2));
    }

    return entries;
};

const before = dirtySet();

for (const [command, args] of GENERATORS) {
    try {
        execFileSync(command, args, { cwd: rootDir, stdio: "pipe" });
    } catch (error) {
        console.error(`❌ Generator failed: ${command} ${args.join(" ")}`);
        console.error(String(error.stderr ?? error.message));

        process.exit(1);
    }
}

const after = dirtySet();
const changed = [...after].filter(([path, status]) => before.get(path) !== status).map(([path]) => path);

if (changed.length > 0) {
    console.error(`❌ ${changed.length} committed file(s) do not match their generator's output:`);
    console.error("");

    for (const path of changed) {
        console.error(`   ${path}`);
    }

    console.error("");
    console.error("   Re-run the generators and commit the result:");

    for (const [command, args] of GENERATORS) {
        console.error(`     ${command} ${args.join(" ")}`);
    }

    process.exit(1);
}

console.log(`✅ All ${GENERATORS.length} generators reproduce their committed output.`);
