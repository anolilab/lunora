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
 * Two reference apps, each against its own baseline in `worker-size.json`:
 *  - `templates/standalone` — the smallest starter, and what a new project is: the
 *    framework's own weight. Deliberately NOT `apps/playground`, which accumulates
 *    feature demos and would track demo churn rather than the framework's.
 *  - `templates/saas` — the heaviest starter: eight registry items composed into one
 *    Worker with better-auth, Stripe and a TanStack Start SSR handler. Composition
 *    is how a template quietly outgrows the platform, and the standalone app
 *    cannot see it.
 *
 * The measurement comes from `lunora build --format json`, so the gate and the
 * number a user sees are produced by the same code path.
 *
 * Usage:
 *   pnpm run worker-size:check             # fail when a bundle exceeds its ceiling
 *   pnpm run worker-size:update            # re-baseline after an intentional increase
 *   node scripts/check-worker-size.js saas # weigh one template (either mode)
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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { materializeTemplate } from "./materialize-template.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(rootDir, "worker-size.json");
const update = process.argv.includes("--update");

const fail = (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
};

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

/**
 * Cloudflare's Worker size limit — 64 MiB uncompressed, the same on Free and
 * Paid. There is no compressed limit; only the uncompressed bundle counts.
 * https://developers.cloudflare.com/workers/platform/limits/#worker-size
 *
 * Mirrors `WORKER_SIZE_LIMIT_BYTES` in
 * `packages/cli/src/commands/build/bundle-size.ts` (what `lunora build` warns
 * against). This script cannot import it — it measures that CLI's own output —
 * so change both together.
 */
const RAW_LIMIT_BYTES = 64 * 1024 * 1024;

/** Build a reference app and return `lunora build`'s `bundle` measurement. */
const measure = (template, appDirectory) => {
    const cli = join(rootDir, "packages", "cli", "dist", "bin.mjs");

    if (!existsSync(cli)) {
        fail(`check-worker-size: ${cli} is missing — run \`pnpm run build:packages:prod\` first.`);
    }

    let stdout;

    try {
        stdout = execFileSync(process.execPath, [cli, "build", "--no-startup-check", "--format", "json", "--out-dir", "out"], {
            cwd: appDirectory,
            encoding: "utf8",
            env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
            maxBuffer: 64 * 1024 * 1024,
            stdio: ["ignore", "pipe", "inherit"],
        });
    } catch {
        fail(`check-worker-size: \`lunora build\` failed on templates/${template} (its output is above).`);
    }

    // `--format json` puts every command's payload under `data` in the shared
    // `{ code, data, error }` envelope, so the measurement is `data.bundle`.
    const { bundle } = JSON.parse(stdout).data ?? {};

    // A measurement of zero must never pass as a healthy result: that is exactly
    // what a changed wrangler out-dir layout would look like.
    if (!bundle || bundle.files < 1 || bundle.gzipBytes < 1) {
        fail(`check-worker-size: \`lunora build\` reported no bundle for templates/${template} — the wrangler out-dir layout may have changed.`);
    }

    return bundle;
};

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const requested = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const unknown = requested.filter((template) => !(template in fixture.templates));

if (unknown.length > 0) {
    fail(`check-worker-size: no baseline for ${unknown.join(", ")} in worker-size.json (known: ${Object.keys(fixture.templates).join(", ")}).`);
}

const failures = [];

for (const template of requested.length > 0 ? requested : Object.keys(fixture.templates)) {
    const baseline = fixture.templates[template];
    const appDirectory = join(mkdtempSync(join(tmpdir(), "lunora-worker-size-")), "app");

    let bundle;

    try {
        materializeTemplate(template, appDirectory, { name: "lunora-worker-size-reference" });
        bundle = measure(template, appDirectory);
    } finally {
        rmSync(join(appDirectory, ".."), { force: true, recursive: true });
    }

    const ceiling = baseline.gzipBytes + baseline.allowanceBytes;

    process.stdout.write(
        `worker size (${template}): ${kib(bundle.rawBytes)} raw, ${kib(bundle.gzipBytes)} gzipped — ` +
            `baseline ${kib(baseline.gzipBytes)}, ceiling ${kib(ceiling)}\n`,
    );

    if (update) {
        const delta = bundle.gzipBytes - baseline.gzipBytes;

        fixture.templates[template] = { ...baseline, gzipBytes: bundle.gzipBytes, rawBytes: bundle.rawBytes };
        process.stdout.write(`worker-size.json (${template}): ${delta >= 0 ? "+" : ""}${kib(delta)} gzipped against the previous baseline.\n`);

        continue;
    }

    // Cloudflare's only size ceiling is the 64 MiB uncompressed limit (both plans;
    // there is no compressed limit). The baseline check below is a regression
    // signal measured in gzip, so it cannot see a bundle that compresses extremely
    // well — a large generated lookup table is tiny gzipped and enormous raw. That
    // bundle would pass the gate and be rejected at upload, so the raw limit gets
    // its own absolute check.
    if (bundle.rawBytes > RAW_LIMIT_BYTES) {
        failures.push(
            `The reference Worker (templates/${template}) exceeds Cloudflare's pre-compression limit.\n` +
                `  raw:   ${kib(bundle.rawBytes)}\n` +
                `  limit: ${kib(RAW_LIMIT_BYTES)} before compression (both plans)\n` +
                `This is an upload-time rejection, not a budget — accepting it with \`worker-size:update\` will not help.`,
        );
    } else if (bundle.gzipBytes > ceiling) {
        failures.push(
            `The reference Worker (templates/${template}) grew past its ceiling.\n` +
                `  now:      ${kib(bundle.gzipBytes)} gzipped (${kib(bundle.rawBytes)} raw)\n` +
                `  baseline: ${kib(baseline.gzipBytes)} gzipped, + ${kib(baseline.allowanceBytes)} allowance = ${kib(ceiling)}\n` +
                `  delta:    +${kib(bundle.gzipBytes - baseline.gzipBytes)} against the baseline\n` +
                `Every app built from this template carries this. Find what arrived (\`lunora analyze\` prints the heaviest\n` +
                `modules), and if the growth is intended, accept it with \`pnpm run worker-size:update\` so the increase\n` +
                `is visible in review rather than buried.`,
        );
    }
}

if (update) {
    writeFileSync(fixturePath, `${JSON.stringify(fixture, undefined, 4)}\n`, "utf8");
} else if (failures.length > 0) {
    fail(failures.join("\n\n"));
}
