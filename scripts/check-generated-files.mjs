/**
 * Guards against a committed generator output going stale.
 *
 * Several files in this repo are written by a script and committed:
 * `labeler-config.yml`, each package's `__assets__/package-og.svg` + README block,
 * `apps/docs/src/data/packages.ts`, and every example's `lunora/_generated` tree.
 * Nothing re-ran the generators in CI and compared, so a committed output could
 * drift from what the generator produces and no gate noticed.
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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The `lunora` CLI, built. `lunora codegen` runs from it, so it has to exist before the sweep. */
const cliBin = join(rootDir, "packages/lunora/dist/bin.mjs");

/**
 * `lunora codegen` for every example that commits its `lunora/_generated` tree.
 *
 * This is the repo's primary generator, and it was the one this gate did not
 * cover: all 13 examples had drifted from what `packages/codegen` emits (a
 * `lifecycle` field and the reactor dispatch, in `functions.ts` + `shard.ts`),
 * because nothing re-ran codegen and compared. The `eslint` job regenerates these
 * trees as a `dependsOn` side effect and throws the result away — the same
 * masking that hid `apps/docs/src/data/packages.ts`.
 *
 * Discovered, not listed: a new example is covered the moment it has a `codegen`
 * script, with nothing to remember here. `templates/*` and `apps/playground` are
 * deliberately absent — they `.gitignore` `lunora/_generated` and commit no
 * generated output, so there is nothing to hold them to.
 */
const codegenWorkspaces = () =>
    readdirSync(join(rootDir, "examples"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join("examples", entry.name))
        .filter((dir) => {
            const manifest = join(rootDir, dir, "package.json");

            return existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).scripts?.codegen !== undefined;
        })
        .sort();

/** The generators that own a committed file, in the order postinstall/build run them. */
const GENERATORS = [
    ["node", ["scripts/generate-labeler-config.js", "--skip-ci"]],
    ["node", ["scripts/generate-package-og-images.js"]],
    ["node", ["apps/docs/scripts/generate-packages.js"]],
    // Its own declared `codegen` script, not a hand-rolled CLI call: that is the
    // script discovery keys on, and it is what the workspace actually runs, so a
    // flag added there is honoured here instead of silently diverging.
    ...codegenWorkspaces().map((dir) => ["pnpm", ["run", "codegen"], dir]),
];

if (!existsSync(cliBin)) {
    console.error(`❌ The \`lunora\` CLI is not built: ${cliBin} is missing.`);
    console.error("");
    console.error("   `lunora codegen` regenerates the examples' committed `lunora/_generated`");
    console.error("   trees, so this check needs a build first:");
    console.error("");
    console.error("     pnpm run build:packages");

    process.exit(1);
}

/** A generator as you would re-run it by hand, `cd`-prefixed when it runs inside a workspace. */
const describe = (command, args, cwd) => `${cwd === undefined ? "" : `cd ${cwd} && `}${command} ${args.join(" ")}`;

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

for (const [command, args, cwd] of GENERATORS) {
    try {
        execFileSync(command, args, { cwd: cwd === undefined ? rootDir : join(rootDir, cwd), stdio: "pipe" });
    } catch (error) {
        console.error(`❌ Generator failed: ${describe(command, args, cwd)}`);
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

    for (const [command, args, cwd] of GENERATORS) {
        console.error(`     ${describe(command, args, cwd)}`);
    }

    process.exit(1);
}

console.log(`✅ All ${GENERATORS.length} generators reproduce their committed output.`);
