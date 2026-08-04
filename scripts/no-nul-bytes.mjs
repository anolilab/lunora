#!/usr/bin/env node
// Pre-commit guard: reject a raw NUL byte (0x00) in a staged source file.
//
// A NUL in a `.ts` source makes git classify the file as *binary* — it then
// vanishes from `git diff`, `git blame`, and PR review, so a load-bearing module
// can ship unreviewable (this happened once: a `seriesKey` template used a raw
// `\0` separator instead of the `\u0000` escape). Prettier/ESLint do not catch
// it, so this runs in `vis.config.ts`'s `staged` block. Use the `\u0000` escape,
// which is byte-identical at runtime but keeps the file valid UTF-8 text.
//
// Two modes:
//   node scripts/no-nul-bytes.mjs <paths...>   staged files (vis-staged convention)
//   node scripts/no-nul-bytes.mjs              the whole tracked tree
//
// The staged mode is the fast one that gives the author the error at commit
// time. It cannot converge the tree on its own, though: it only ever sees files
// someone staged, so anything committed before this guard existed — or through
// a path that skips the hook — stays invisible. Six files were in exactly that
// state, two of which a later commit modified without the guard ever running on
// them. The argv-less mode is the sweep that closes it, run from `postinstall`
// alongside the other repo-invariant checks.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Extensions the staged block covers — the same set, so the two modes agree. */
const TRACKED = /\.(?:cjs|cts|js|json|json5|jsonc|jsx|md|mdx|mjs|mts|toml|ts|tsx|yaml|yml)$/u;

/**
 * Every tracked file worth scanning. Restricted to the staged block's
 * extensions on purpose: a bare whole-tree scan drowns in vendored content and
 * genuine binaries (fonts, `.webp`, `.ico`), which legitimately contain NULs.
 */
const trackedFiles = () =>
    execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        .split("\u0000")
        .filter((file) => file !== "" && TRACKED.test(file));

const argv = process.argv.slice(2);
const files = argv.length > 0 ? argv : trackedFiles();
const offenders = [];

for (const file of files) {
    let contents;

    try {
        contents = readFileSync(file);
    } catch {
        // A deleted/renamed path can still be passed; nothing to check.
        continue;
    }

    if (contents.includes(0)) {
        offenders.push(file);
    }
}

if (offenders.length > 0) {
    process.stderr.write(
        `Raw NUL byte (0x00) in ${String(offenders.length)} ${argv.length > 0 ? "staged" : "tracked"} file(s) — this makes git treat the file as binary (invisible in diff/blame/review).\n` +
            `Use the \\u0000 escape instead (byte-identical at runtime):\n` +
            offenders.map((file) => `  ${file}`).join("\n") +
            "\n",
    );
    process.exit(1);
}
