#!/usr/bin/env node
// Pre-commit step: build the workspace dependencies of every package that owns a
// staged file, before the staged eslint run.
//
// The type-aware eslint rules resolve `@lunora/*` imports through each package's
// `dist/` declarations. When a dependency is not built, its types collapse to
// `any`, so rules such as `restrict-template-expressions` report errors that do
// not exist, and `eslint --fix` can rewrite code to fit the wrong types (#1456).
// CI's eslint job builds the affected graph first for the same reason.
//
// One `vis run build` covers every staged package, with `-F "<name>^..."` (the
// dependencies, not the package itself, which eslint reads from source). It must
// stay a single call that runs before eslint in the same `staged` array: packem
// cleans `dist/` when a build starts, so two builds over shared dependencies, or a
// build next to a running eslint, would race the declaration reads. With a warm
// vis cache this takes a few seconds.
//
//   node scripts/staged-build-deps.mjs <paths...>   staged files (vis-staged convention)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `packages/<dir>` for a staged path, or undefined when it is not inside one. */
const packageDirectory = (file) => {
    const [top, name] = relative(rootDir, file).split(sep);

    return top === "packages" && name ? join(rootDir, top, name) : undefined;
};

const names = new Set();

for (const file of process.argv.slice(2)) {
    const directory = packageDirectory(file);
    const manifest = directory && join(directory, "package.json");

    if (manifest && existsSync(manifest)) {
        names.add(JSON.parse(readFileSync(manifest, "utf8")).name);
    }
}

if (names.size === 0) {
    process.exit(0);
}

const filters = [...names].flatMap((name) => ["-F", `${name}^...`]);
const result = spawnSync("pnpm", ["exec", "vis", "run", "build", ...filters], { cwd: rootDir, stdio: "inherit" });

if (result.status !== 0) {
    process.stderr.write(
        `\nBuilding the workspace dependencies of ${[...names].join(", ")} failed, so the staged eslint run was skipped.\n` +
            "Type-aware rules need those dependencies built: without their dist/ declarations the imported types resolve to `any` and eslint reports false errors.\n" +
            "Fix the build error above, or run `pnpm run build:packages`, then commit again.\n",
    );
    process.exit(1);
}
