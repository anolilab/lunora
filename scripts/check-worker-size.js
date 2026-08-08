#!/usr/bin/env node
/**
 * Weighs the Worker a new user actually deploys, and fails when it grows past a
 * committed ceiling.
 *
 * Nothing else in this repo measures bytes. `dist:check` audits whether a built
 * `dist/` is production-clean, and per-package sizes answer the wrong question
 * entirely: every entrypoint is a re-export shim (`packages/runtime/dist/index.mjs`
 * is 2 KiB while its code sits in `dist/packem_shared/`). Only the bundled Worker
 * is a real number, and the first person to learn this framework's floor should
 * not be a user whose deploy Cloudflare rejected for a dependency added weeks ago.
 *
 * The reference app is `templates/standalone` — the smallest starter, and what a
 * new project is. Deliberately NOT `apps/playground`, which accumulates feature
 * demos (auth-ui, db, queue, workflow, studio…) and would track demo churn rather
 * than the framework's own weight.
 *
 * The measurement comes from `lunora build --format json`, so the gate and the
 * number a user sees are produced by the same code path.
 *
 * Usage:
 *   pnpm run worker-size:check     # fail when the bundle exceeds the ceiling
 *   pnpm run worker-size:update    # re-baseline after an intentional increase
 *
 * PREREQUISITE: `pnpm run build:packages:prod`. The reference app resolves the
 * workspace `dist/` directories, and users install the PRODUCTION build — a plain
 * `build:packages` measures a development bundle roughly 25% heavier, which is a
 * number nobody deploys.
 *
 * Runs as its own CI job, NOT from `postinstall`: a failing postinstall gate turns
 * every job red in its setup step, and the cause is invisible in the job that
 * reports it.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(rootDir, "worker-size.json");
const update = process.argv.includes("--update");

const fail = (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
};

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

/**
 * Materialize the reference template as a project whose dependencies resolve.
 *
 * A symlink farm rather than an install: every `@lunora/*` dependency is a
 * workspace package that already has its own `node_modules`, so linking the
 * package directories is enough for esbuild to resolve the whole graph — and it
 * keeps the gate offline and quick. `pnpm install` here would try to fetch
 * `lunorash@^0.0.0` from the registry instead.
 */
const materialize = (appDirectory) => {
    cpSync(join(rootDir, "templates", "standalone"), appDirectory, { recursive: true });

    for (const file of ["package.json", "wrangler.jsonc"]) {
        const path = join(appDirectory, file);

        writeFileSync(path, readFileSync(path, "utf8").replaceAll("{{name}}", "lunora-worker-size-reference"), "utf8");
    }

    // The CLI runs wrangler through the project's package manager. A pnpm-shaped
    // project makes `pnpm exec` verify the (absent) lockfile first and abort;
    // `npx --` runs the linked binary directly, so the reference app declares
    // itself npm-shaped with an empty lockfile.
    writeFileSync(join(appDirectory, "package-lock.json"), '{ "lockfileVersion": 3 }\n', "utf8");

    const modules = join(appDirectory, "node_modules");

    mkdirSync(join(modules, "@lunora"), { recursive: true });

    for (const directory of readdirSync(join(rootDir, "packages"))) {
        const source = join(rootDir, "packages", directory);
        const manifest = join(source, "package.json");

        if (existsSync(manifest)) {
            symlinkSync(source, join(modules, JSON.parse(readFileSync(manifest, "utf8")).name));
        }
    }

    // wrangler and the Workers types come from a workspace package that already
    // depends on them, so the gate needs no dependencies of its own.
    const host = join(rootDir, "packages", "runtime", "node_modules");

    symlinkSync(join(host, "wrangler"), join(modules, "wrangler"));
    symlinkSync(join(host, "@cloudflare"), join(modules, "@cloudflare"));
    mkdirSync(join(modules, ".bin"), { recursive: true });
    symlinkSync(join(host, ".bin", "wrangler"), join(modules, ".bin", "wrangler"));
};

/** Build the reference app and return `lunora build`'s `bundle` measurement. */
const measure = (appDirectory) => {
    const cli = join(rootDir, "packages", "cli", "dist", "bin.mjs");

    if (!existsSync(cli)) {
        fail(`check-worker-size: ${cli} is missing — run \`pnpm run build:packages:prod\` first.`);
    }

    let stdout;

    try {
        stdout = execFileSync(process.execPath, [cli, "build", "--format", "json", "--out-dir", "out"], {
            cwd: appDirectory,
            encoding: "utf8",
            env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
            maxBuffer: 64 * 1024 * 1024,
            stdio: ["ignore", "pipe", "inherit"],
        });
    } catch {
        fail("check-worker-size: `lunora build` failed on the reference template (its output is above).");
    }

    const result = JSON.parse(stdout);

    // A measurement of zero must never pass as a healthy result: that is exactly
    // what a changed wrangler out-dir layout would look like.
    if (!result.bundle || result.bundle.files < 1 || result.bundle.gzipBytes < 1) {
        fail("check-worker-size: `lunora build` reported no bundle — the wrangler out-dir layout may have changed.");
    }

    return result.bundle;
};

const baseline = JSON.parse(readFileSync(fixturePath, "utf8"));
const appDirectory = join(mkdtempSync(join(tmpdir(), "lunora-worker-size-")), "app");

let bundle;

try {
    materialize(appDirectory);
    bundle = measure(appDirectory);
} finally {
    rmSync(join(appDirectory, ".."), { force: true, recursive: true });
}

const ceiling = baseline.gzipBytes + baseline.allowanceBytes;

process.stdout.write(
    `worker size (${baseline.template}): ${kib(bundle.rawBytes)} raw, ${kib(bundle.gzipBytes)} gzipped — ` +
        `baseline ${kib(baseline.gzipBytes)}, ceiling ${kib(ceiling)}\n`,
);

if (update) {
    const delta = bundle.gzipBytes - baseline.gzipBytes;

    writeFileSync(fixturePath, `${JSON.stringify({ ...baseline, gzipBytes: bundle.gzipBytes, rawBytes: bundle.rawBytes }, undefined, 4)}\n`, "utf8");
    process.stdout.write(`worker-size.json updated: ${delta >= 0 ? "+" : ""}${kib(delta)} gzipped against the previous baseline.\n`);

    process.exit(0);
}

if (bundle.gzipBytes > ceiling) {
    fail(
        `The reference Worker (templates/${baseline.template}) grew past its ceiling.\n` +
            `  now:      ${kib(bundle.gzipBytes)} gzipped (${kib(bundle.rawBytes)} raw)\n` +
            `  baseline: ${kib(baseline.gzipBytes)} gzipped, + ${kib(baseline.allowanceBytes)} allowance = ${kib(ceiling)}\n` +
            `  delta:    +${kib(bundle.gzipBytes - baseline.gzipBytes)} against the baseline\n` +
            `Every Lunora app carries this. Find what arrived (\`lunora analyze\` prints the heaviest modules),\n` +
            `and if the growth is intended, accept it with \`pnpm run worker-size:update\` so the increase is\n` +
            `visible in review rather than buried.`,
    );
}
