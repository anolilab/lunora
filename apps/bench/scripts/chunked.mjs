#!/usr/bin/env node
/**
 * Chunked-build bench: does a Vite (rolldown) artifact, uploaded as many modules,
 * start faster than wrangler's single-file esbuild bundle (plan 490 §4 / §6)?
 *
 * Six artifacts at one app size, each frozen with `wrangler deploy --dry-run
 * --outfile` and profiled with `wrangler check startup --workerBundle`, runs
 * interleaved across artifacts:
 *
 * - `esbuild`: `lunora build --no-framework-build`, the single file `startup.mjs` measures;
 * - `rolldown`: `vite build --minify` through `@lunora/vite`, rolldown's default chunking;
 * - `rolldown-strict`: the same with `output.strictExecutionOrder`, which evaluates each
 *   chunk's modules in source order. The default output of some graphs does not boot
 *   (see FINDINGS.md), and this is the setting that makes it.
 *
 * each in the eager and the `--lazy-functions` registry. An artifact that fails to
 * start is reported with its error rather than aborting the run. "Active" is the
 * profiler's CPU time for the startup phase; whether it includes V8's compile of
 * modules that are uploaded but never imported is not documented, so a lower figure
 * for a chunked artifact may partly be compile time it does not count.
 *
 *   node scripts/chunked.mjs                        # customer preset, 7 runs
 *   node scripts/chunked.mjs --preset core --runs 5
 *
 * Results go to `.bench/results/` (gitignored) as JSON; a table is printed.
 * Prerequisite: built packages (`pnpm --filter "@lunora/bench..." run build:prod`).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

import { startupActiveMs, summarize } from "../../../scripts/worker-startup-measure.js";
import { appDirectory, sizeFromArgs } from "./generate.mjs";
import { benchDirectory, buildMode, quietEnv, sizeLabel, withSizedApp, wrangler } from "./sized-app.mjs";

const { values } = parseArgs({
    options: {
        domains: { type: "string" },
        "heavy-share": { type: "string" },
        keep: { default: false, type: "boolean" },
        preset: { default: "customer", type: "string" },
        runs: { default: "7", type: "string" },
    },
});

const runs = Number(values.runs);
// `--preset` has a default, so `--domains` must override it rather than be ignored.
const preset = values.domains === undefined ? values.preset : undefined;
const size = sizeFromArgs({ domains: values.domains, heavyShare: values["heavy-share"], preset });
const presetName = sizeLabel({ domains: values.domains, preset }, size);
const vite = join(appDirectory, "node_modules", ".bin", "vite");
const strictConfig = join(benchDirectory, "vite.strict.config.ts");
// `@cloudflare/vite-plugin` writes this after every build; while it exists, wrangler deploys the Vite output instead of the source.
const redirect = join(appDirectory, ".wrangler", "deploy", "config.json");

const freeze = (name) => {
    const bundle = join(benchDirectory, `chunked-${name}.bundle`);

    execFileSync(wrangler, ["deploy", "--dry-run", "--outfile", bundle], { cwd: appDirectory, env: quietEnv, stdio: ["ignore", "ignore", "inherit"] });

    return bundle;
};

/** JS modules of a frozen multipart upload: their count and bytes (source maps and metadata excluded). */
const uploadShape = (bundle) => {
    const raw = readFileSync(bundle).toString("latin1");
    const boundary = raw.slice(0, raw.indexOf("\r\n"));
    const modules = raw
        .split(boundary)
        .map((part) => /filename="([^"]+)"[\s\S]*?\r\n\r\n([\s\S]*)\r\n$/u.exec(part))
        .filter((match) => match !== null && /\.m?js$/u.test(match[1]))
        .map((match) => Buffer.from(match[2], "latin1"));

    return { bytes: modules.reduce((sum, body) => sum + body.length, 0), gzipBytes: gzipSync(Buffer.concat(modules)).length, modules: modules.length };
};

/** `vite build` in `mode`; `@lunora/vite` runs codegen inside it and reads the lazy opt-in from the env, as `lunora build` passes it. */
const viteBuild = (mode, strict) => {
    rmSync(join(appDirectory, "dist"), { force: true, recursive: true });
    execFileSync(vite, ["build", "--minify", ...(strict ? ["--config", strictConfig] : [])], {
        cwd: appDirectory,
        env: { ...quietEnv, LUNORA_STRICT_ADVISORIES: "0", ...(mode === "lazy" ? { LUNORA_LAZY_FUNCTIONS: "1" } : {}) },
        stdio: ["ignore", "ignore", "inherit"],
    });
};

/** One profile; a startup that throws is recorded as the first line of wrangler's error. */
const profile = (bundle, name) => {
    try {
        return { ms: startupActiveMs(appDirectory, { profile: join(benchDirectory, `chunked-${name}.cpuprofile`), wrangler, workerBundle: bundle }) };
    } catch (error) {
        const detail = String(error.stderr ?? error.message).replaceAll(/\u001B\[[\d;]*m/gu, "");

        // wrangler's message goes on to list bindings it cannot reproduce, which is not the cause; the cause is only in `wrangler dev`.
        return { error: (/ERROR\]\s*(.+?)(?: The upload contains|$)/mu.exec(detail)?.[1] ?? detail).slice(0, 120) };
    }
};

mkdirSync(join(benchDirectory, "results"), { recursive: true });
writeFileSync(
    strictConfig,
    `import { mergeConfig } from "vite";

import base from "../vite.config";

export default (env) => mergeConfig(base(env), { build: { rolldownOptions: { output: { strictExecutionOrder: true } } } });
`,
    "utf8",
);

const loadBefore = loadavg();
const artifacts = {};
const shape = await withSizedApp(size, { keep: values.keep }, (generated) => {
    try {
        // The single-file builds first: `buildWorker` refuses while a Vite redirect exists.
        for (const mode of ["eager", "lazy"]) {
            process.stderr.write(`[chunked] ${presetName}: esbuild ${mode}…\n`);
            buildMode(mode);
            artifacts[`esbuild-${mode}`] = { bundle: freeze(`esbuild-${mode}`) };
        }

        for (const [variant, strict] of [
            ["rolldown", false],
            ["rolldown-strict", true],
        ]) {
            for (const mode of ["eager", "lazy"]) {
                process.stderr.write(`[chunked] ${presetName}: ${variant} ${mode}…\n`);
                viteBuild(mode, strict);
                artifacts[`${variant}-${mode}`] = { bundle: freeze(`${variant}-${mode}`) };
                rmSync(redirect, { force: true });
            }
        }
    } finally {
        rmSync(redirect, { force: true });
    }

    for (const [name, artifact] of Object.entries(artifacts)) {
        Object.assign(artifact, uploadShape(artifact.bundle), { errors: [], samples: [] });
        artifact.name = name;
    }

    for (let run = 0; run < runs; run++) {
        for (const artifact of Object.values(artifacts)) {
            if (artifact.errors.length > 0) {
                continue;
            }

            const result = profile(artifact.bundle, artifact.name);

            (result.error === undefined ? artifact.samples : artifact.errors).push(result.ms ?? result.error);
        }

        process.stderr.write(
            `[chunked] run ${String(run + 1)}/${String(runs)}: ${Object.values(artifacts)
                .map((artifact) => `${artifact.name} ${artifact.errors.length > 0 ? "failed" : String(artifact.samples.at(-1))}`)
                .join(", ")} (load ${loadavg()[0].toFixed(1)})\n`,
        );
    }

    return generated;
});

const gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: appDirectory, encoding: "utf8" }).trim();
const report = {
    artifacts: Object.fromEntries(
        Object.values(artifacts).map(({ bundle, ...artifact }) => [
            artifact.name,
            { ...artifact, active: artifact.samples.length > 0 ? summarize(artifact.samples) : undefined },
        ]),
    ),
    at: new Date().toISOString(),
    gitSha,
    loadavg: { after: loadavg(), before: loadBefore },
    preset: presetName,
    runs,
    shape,
};
const file = join(benchDirectory, "results", `chunked-${presetName}-${report.at.replaceAll(/[:.]/gu, "-")}.json`);

writeFileSync(file, `${JSON.stringify(report, undefined, 4)}\n`, "utf8");

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const rows = Object.entries(report.artifacts).map(([name, artifact]) => [
    name,
    artifact.active === undefined
        ? `failed: ${artifact.errors[0]}`
        : `${String(artifact.active.median)} / ${String(artifact.active.min)} / ${String(artifact.active.max)}`,
    String(artifact.modules),
    `${mib(artifact.bytes)} (${mib(artifact.gzipBytes)} gz)`,
]);
const header = ["artifact", "Active ms med/min/max", "JS modules", "JS bytes"];
const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");

process.stdout.write(
    `\nchunked — ${presetName} (${String(runs)} interleaved runs, load ${loadBefore[0].toFixed(1)} → ${loadavg()[0].toFixed(1)}, ${gitSha})\n`,
);
process.stdout.write(`${line(header)}\n${line(widths.map((width) => "-".repeat(width)))}\n${rows.map((row) => line(row)).join("\n")}\n\n${file}\n`);
