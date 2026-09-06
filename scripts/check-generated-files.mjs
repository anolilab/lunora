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
 * paths (a generator added later is covered automatically). The snapshot pairs each
 * dirty path with a digest of its CONTENT — the status code alone cannot tell an
 * already-modified output that a generator then rewrote from one it left alone.
 *
 * Run: node scripts/check-generated-files.mjs
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/**
 * Every `examples/*` that COMMITS a `lunora/_generated` tree, from git rather
 * than from a hand-kept list.
 *
 * `codegenWorkspaces()` discovers by the presence of a `codegen` script, so
 * renaming or deleting that script in one example silently drops it from the
 * sweep — the run then prints "All 15 generators…" and stays green. Committed
 * generated output is the thing that can go stale, so it is the floor: an
 * example that commits one has to be covered.
 */
const committedGeneratedExamples = () => {
    const raw = execFileSync("git", ["ls-files", "--", "examples/*/lunora/_generated/*"], { cwd: rootDir, encoding: "utf8" });

    return [
        ...new Set(
            raw
                .split("\n")
                .filter(Boolean)
                .map((path) => path.split("/").slice(0, 2).join("/")),
        ),
    ].sort();
};

const covered = new Set(codegenWorkspaces());
const uncovered = committedGeneratedExamples().filter((dir) => !covered.has(dir));

if (uncovered.length > 0) {
    console.error(`❌ ${uncovered.length} example(s) commit a \`lunora/_generated\` tree that this sweep never regenerates:`);
    console.error("");

    for (const dir of uncovered) {
        console.error(`   ${dir} — no \`codegen\` script in its package.json`);
    }

    console.error("");
    console.error("   Restore the script (discovery keys on it), or stop committing the generated tree.");

    process.exit(1);
}

/** The generators that own a committed file, in the order postinstall/build run them. */
const GENERATORS = [
    // NOT `--skip-ci`. That flag is for the root `postinstall`, and
    // `generate-labeler-config.js` honours it by writing NOTHING when `CI` is
    // set — which GitHub Actions always sets. Passing it here ran 15 of the 16
    // generators in CI, satisfied the before/after comparison vacuously, and
    // still printed "All 16 generators reproduce their committed output": add a
    // package, let `labeler-config.yml` go stale, and only a local run noticed.
    ["node", ["scripts/generate-labeler-config.js"]],
    ["node", ["scripts/generate-package-og-images.js"]],
    ["node", ["apps/docs/scripts/generate-packages.js"]],
    // Its own declared `codegen` script, not a hand-rolled CLI call: that is the
    // script discovery keys on, and it is what the workspace actually runs, so a
    // flag added there is honoured here instead of silently diverging.
    ...codegenWorkspaces().map((dir) => ["pnpm", ["run", "codegen"], dir]),
];

/** The newest mtime under `dir`, or 0 when it does not exist. */
const newestMtime = (dir) => {
    let newest = 0;
    const queue = [dir];

    while (queue.length > 0) {
        const current = queue.pop();

        let entries;

        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const full = join(current, entry.name);

            if (entry.isDirectory()) {
                queue.push(full);
            } else if (entry.isFile()) {
                newest = Math.max(newest, statSync(full).mtimeMs);
            }
        }
    }

    return newest;
};

if (!existsSync(cliBin)) {
    console.error(`❌ The \`lunora\` CLI is not built: ${cliBin} is missing.`);
    console.error("");
    console.error("   `lunora codegen` regenerates the examples' committed `lunora/_generated`");
    console.error("   trees, so this check needs a build first:");
    console.error("");
    console.error("     pnpm run build:packages");

    process.exit(1);
}

/**
 * The binary EXISTING is not the same as it being current.
 *
 * `lunora codegen` runs out of `packages/lunora/dist/bin.mjs`, which loads
 * `@lunora/cli` then `@lunora/codegen` from THEIR `dist/`. Edit
 * `packages/codegen/src/emit.ts`, run this without rebuilding, and the sweep
 * regenerates every example with the OLD emitter, matches the committed tree,
 * and prints a tick — the drift it exists to catch, reported as absent. CI
 * happens to build first (`lint.yml`'s "Build packages" step), but nothing in
 * this script required it, so a local run and a reordered workflow both lied.
 *
 * Two deliberate narrowings, both because a wider rule reports staleness that
 * is not there and teaches everyone to ignore this gate:
 *
 *  - Only the umbrella's dependency closure. A dirty `packages/react/src` has
 *    no bearing on what the emitter writes.
 *  - Only sources git reports as DIRTY. `dist/` is restored from the build
 *    cache with its cached mtimes and a branch checkout rewrites source mtimes
 *    wholesale, so a plain "newest src vs newest dist" comparison calls most of
 *    the repo stale in a freshly built tree. An uncommitted edit that postdates
 *    the build is the case mtimes answer honestly.
 */
const emitterClosure = () => {
    const dirOfName = new Map();

    for (const entry of readdirSync(join(rootDir, "packages"), { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }

        try {
            const { name } = JSON.parse(readFileSync(join(rootDir, "packages", entry.name, "package.json"), "utf8"));

            dirOfName.set(name, `packages/${entry.name}`);
        } catch {
            continue;
        }
    }

    const closure = new Set();
    const queue = ["lunorash"];

    while (queue.length > 0) {
        const name = queue.pop();
        const dir = dirOfName.get(name);

        if (dir === undefined || closure.has(dir)) {
            continue;
        }

        closure.add(dir);

        const manifest = JSON.parse(readFileSync(join(rootDir, dir, "package.json"), "utf8"));

        queue.push(...Object.keys(manifest.dependencies ?? {}).filter((dependency) => dirOfName.has(dependency)));
    }

    return closure;
};

const staleFromDirtySources = () => {
    const closure = emitterClosure();
    const raw = execFileSync("git", ["status", "--porcelain=v1", "--", "packages/*/src/*"], { cwd: rootDir, encoding: "utf8" });
    const distMtime = new Map();
    const stale = new Set();

    for (const line of raw.split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        // "XY <path>", and for a rename "XY <old> -> <new>" — the destination is
        // the file on disk.
        const path = line.slice(3).trim().split(" -> ").pop();
        const packageDir = path.split("/").slice(0, 2).join("/");

        if (!closure.has(packageDir)) {
            continue;
        }

        if (!distMtime.has(packageDir)) {
            distMtime.set(packageDir, newestMtime(join(rootDir, packageDir, "dist")));
        }

        const built = distMtime.get(packageDir);

        if (built === 0) {
            continue;
        }

        let sourceMtime;

        try {
            sourceMtime = statSync(join(rootDir, path)).mtimeMs;
        } catch {
            // Deleted source, `dist/` still carrying what it compiled to.
            stale.add(packageDir);

            continue;
        }

        if (sourceMtime > built) {
            stale.add(packageDir);
        }
    }

    return [...stale].sort();
};

/**
 * The other half, and the one that gates the workflow rather than the developer:
 * every package behind the emitter has to be BUILT.
 *
 * `lint.yml` runs `build:packages` before `lint:generated`, and if that step is
 * ever dropped or reordered the sweep regenerates with whatever `dist/` happened
 * to be lying around — on a fresh runner, nothing, and the examples would be
 * rewritten from a half-resolved CLI. Asserted by presence rather than by mtime
 * because a build cache legitimately restores `dist/` older than `src/`.
 */
const unbuilt = [...emitterClosure()].filter((dir) => !existsSync(join(rootDir, dir, "dist"))).sort();

if (unbuilt.length > 0) {
    console.error(`❌ ${unbuilt.length} package(s) behind \`lunora codegen\` are not built:`);
    console.error("");

    for (const dir of unbuilt) {
        console.error(`   ${dir}`);
    }

    console.error("");
    console.error("   The sweep loads the emitter from these dist/ trees, so it cannot run without them:");
    console.error("");
    console.error("     pnpm run build:packages");

    process.exit(1);
}

/**
 * The third half: the CI job in FRONT of this script has to run at all.
 *
 * `lint.yml` gates `generated-files` on the `generated_files` path filter in
 * `.github/file-filters.yml`. That filter listed `packages/codegen/**` and
 * nothing else from the emitter's closure — so a PR editing only an advisor
 * lint's remediation text (which every example's `shard.ts` embeds verbatim)
 * matched no filter, the job was skipped, `Check Lint Run` went green, and all
 * 13 examples drifted for the next unrelated codegen PR to trip over. A gate
 * that never runs is indistinguishable from a gate that passes.
 *
 * Parsed with a line scan rather than a YAML dependency: the block is a flat
 * list of quoted globs, and the failure mode of a wrong parse here is a false
 * alarm on a file no other job reads.
 */
const uncoveredByFilter = () => {
    const filtersPath = join(rootDir, ".github/file-filters.yml");
    const lines = readFileSync(filtersPath, "utf8").split("\n");
    const start = lines.findIndex((line) => line.startsWith("generated_files:"));

    if (start === -1) {
        return ["<no `generated_files:` key in .github/file-filters.yml>"];
    }

    const globs = new Set();

    for (const line of lines.slice(start + 1)) {
        // The block ends at the next top-level key; blanks and comments are skipped.
        if (/^\S/.test(line) && line.trim() !== "") {
            break;
        }

        const match = /^\s+-\s+"(.+)"\s*$/.exec(line);

        if (match) {
            globs.add(match[1]);
        }
    }

    return [...emitterClosure()].filter((dir) => !globs.has(`${dir}/**`)).sort();
};

const unfiltered = uncoveredByFilter();

if (unfiltered.length > 0) {
    console.error(`❌ ${unfiltered.length} package(s) behind \`lunora codegen\` are not in the \`generated_files\` path filter:`);
    console.error("");

    for (const dir of unfiltered) {
        console.error(`   ${dir}`);
    }

    console.error("");
    console.error("   A PR touching only those paths skips the `generated-files` job entirely and its");
    console.error("   required check reports green while the examples drift. Add them:");
    console.error("");

    for (const dir of unfiltered) {
        console.error(`     - "${dir}/**"`);
    }

    console.error("");
    console.error("   to `generated_files` in .github/file-filters.yml.");

    process.exit(1);
}

const stale = staleFromDirtySources();

if (stale.length > 0) {
    console.error(`❌ ${stale.length} package(s) behind \`lunora codegen\` have uncommitted sources newer than their build output.`);
    console.error("   The sweep would run an OLD emitter and report no drift:");
    console.error("");

    for (const dir of stale) {
        console.error(`   ${dir}`);
    }

    console.error("");
    console.error("   Rebuild before regenerating, or the comparison proves nothing:");
    console.error("");
    console.error("     pnpm run build:packages");

    process.exit(1);
}

/** A generator as you would re-run it by hand, `cd`-prefixed when it runs inside a workspace. */
const describe = (command, args, cwd) => `${cwd === undefined ? "" : `cd ${cwd} && `}${command} ${args.join(" ")}`;

/**
 * `path -> status + content digest` for every file git considers dirty (modified,
 * added, untracked, …).
 *
 * The digest, not just the status code: a file already modified before the sweep
 * still reports the same two-character code after a generator rewrites it, so keying
 * on the code alone reported NO drift for exactly the outputs most likely to have
 * some — the ones you are mid-edit on. CI's tree is clean, so this only ever went
 * wrong locally, which is worse rather than better: local is where this check is
 * meant to be runnable mid-change.
 *
 * Digest rather than the bytes: some generated trees run to megabytes and the two
 * snapshots are held simultaneously.
 *
 * `-z` rather than the default text format, for two reasons that both end in a
 * silently empty digest. A RENAME prints as `XY <old> -> <new>`, so the whole
 * arrow expression was taken as the path, nothing could be read at it, and both
 * snapshots stored the same empty digest — a renamed generated file that a
 * generator then rewrote reported NO drift, which is exactly the file most
 * likely to have some. And a path with a space or a non-ASCII byte is C-quoted
 * in the text format, which `readFileSync` cannot open either. `-z` NUL-separates
 * the records, never quotes, and puts a rename's new path first with the old one
 * as its own trailing field.
 */
const dirtySet = () => {
    const raw = execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: rootDir, encoding: "utf8" });
    const records = raw.split("\0");
    const entries = new Map();

    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];

        if (record === "") {
            continue;
        }

        // `XY <path>` — the status code is the first two columns, then one space.
        const status = record.slice(0, 2);
        const path = record.slice(3);

        // A rename/copy carries its SOURCE path as the next field. Skip it: the
        // file that exists — and that a generator would rewrite — is this one.
        if (status.startsWith("R") || status.startsWith("C")) {
            index += 1;
        }

        let digest = "";

        try {
            digest = createHash("sha256")
                .update(readFileSync(join(rootDir, path)))
                .digest("hex");
        } catch {
            // A deletion has no file to read; the status code alone carries the
            // change for those.
            digest = "";
        }

        entries.set(path, `${status}:${digest}`);
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
