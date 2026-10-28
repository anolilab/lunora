#!/usr/bin/env node
/**
 * Startup bench: how much CPU the bench Worker spends evaluating its global scope
 * (Cloudflare refuses a Worker above 1 s, error 10021), eager registry vs
 * `--lazy-functions`, at a given app size.
 *
 * For each mode: generate the size, `lunora build` (codegen in that mode, wrangler's
 * single-file esbuild bundle + metafile), then `wrangler deploy --dry-run --outfile`
 * to freeze that exact bundle so `wrangler check startup --workerBundle` can measure
 * the modes INTERLEAVED — on a loaded machine, back-to-back blocks of one mode
 * produce noise that reads as a result.
 *
 *   node scripts/startup.mjs                       # core only, eager + lazy, 7 runs each
 *   node scripts/startup.mjs --preset customer     # ≈ the app behind #1166
 *   node scripts/startup.mjs --domains 20 --runs 11 --modes eager
 *   node scripts/startup.mjs --domains 20 --heavy-share 0.5
 *   node scripts/startup.mjs --keep                # leave the generated domains in place
 *
 * Results go to `.bench/results/` (gitignored) as JSON; a table is printed.
 * Prerequisite: built packages (`pnpm --filter "@lunora/bench..." run build:prod`).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { buildWorker, eagerGraph, eagerPackages, registrySplit, startupActiveMs, summarize } from "../../../scripts/worker-startup-measure.js";
import { appDirectory, generate, sizeFromArgs } from "./generate.mjs";

const { values } = parseArgs({
    options: {
        domains: { type: "string" },
        "heavy-share": { type: "string" },
        keep: { default: false, type: "boolean" },
        modes: { default: "eager,lazy", type: "string" },
        preset: { type: "string" },
        runs: { default: "7", type: "string" },
    },
});

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cli = join(appDirectory, "node_modules", "lunorash", "dist", "bin.mjs");
const wrangler = join(appDirectory, "node_modules", ".bin", "wrangler");
const benchDirectory = join(appDirectory, ".bench");
const modes = values.modes.split(",").map((mode) => mode.trim());
const runs = Number(values.runs);

if (modes.some((mode) => mode !== "eager" && mode !== "lazy")) {
    throw new Error(`--modes takes eager and/or lazy, got "${values.modes}"`);
}

const size = sizeFromArgs({ domains: values.domains, heavyShare: values["heavy-share"], preset: values.preset });
const presetName =
    values.preset ?? (values.domains === undefined ? "core" : `domains-${values.domains}${size.heavyShare > 0 ? `-heavy-${String(size.heavyShare)}` : ""}`);

const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const countMatches = (path, pattern) => (readFileSync(path, "utf8").match(pattern) ?? []).length;
/** Registered function paths (`"ns:name":` keys) — present in both the eager map and the lazy manifest. */
const countFunctions = (path) => new Set(readFileSync(path, "utf8").match(/"[\w/.-]+:\w+"(?=:)/gu)).size;

mkdirSync(join(benchDirectory, "results"), { recursive: true });

// `lunora build` advances the schema baseline; the committed one describes the core-only app.
const schemaBaseline = join(appDirectory, "lunora", ".lunora-schema.json");
const committedBaseline = readFileSync(schemaBaseline, "utf8");
const shape = generate(size);
const loadBefore = loadavg();
const results = {};

try {
    for (const mode of modes) {
        process.stderr.write(`[bench] ${presetName}: building ${mode}…\n`);

        const outDirectory = buildWorker(appDirectory, {
            cli,
            extraArgs: ["--no-framework-build", "--api-spec", "both", ...(mode === "lazy" ? ["--lazy-functions"] : [])],
            outDir: `.bench/out-${mode}`,
        });
        const bundle = join(benchDirectory, `${mode}.bundle`);

        // Freezes exactly what `lunora build` just bundled (same config, same `_generated/`).
        execFileSync(wrangler, ["deploy", "--dry-run", "--outfile", bundle], { cwd: appDirectory, env, stdio: ["ignore", "ignore", "inherit"] });

        const script = readFileSync(join(outDirectory, "server.js"));
        const generated = join(appDirectory, "lunora", "_generated");

        results[mode] = {
            bundle: { bytes: script.length, gzipBytes: gzipSync(script).length },
            eager: eagerGraph(outDirectory),
            functions: countFunctions(join(generated, "functions.ts")),
            packages: eagerPackages(outDirectory, 20),
            registry: registrySplit(outDirectory, { appPrefix: "lunora/" }),
            samples: [],
            tables: countMatches(join(generated, "dataModel.ts"), /^export interface Doc_/gmu),
            workerBundle: bundle,
        };
    }

    for (let run = 0; run < runs; run++) {
        for (const mode of modes) {
            results[mode].samples.push(
                startupActiveMs(appDirectory, { profile: join(benchDirectory, `${mode}.cpuprofile`), wrangler, workerBundle: results[mode].workerBundle }),
            );
        }

        process.stderr.write(`[bench] run ${run + 1}/${runs}: ${modes.map((mode) => `${mode} ${results[mode].samples.at(-1)} ms`).join(", ")}\n`);
    }
} finally {
    if (!values.keep) {
        generate({ domains: 0 });
        writeFileSync(schemaBaseline, committedBaseline, "utf8");
        // Leave `_generated/` eager and core-only, matching the tree, so `tsc` and `lunora dev` see what is committed.
        execFileSync(process.execPath, [cli, "codegen", "--api-spec", "both"], { cwd: appDirectory, env, stdio: "ignore" });
    }
}

const gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: rootDirectory, encoding: "utf8" }).trim();
const report = {
    at: new Date().toISOString(),
    domains: size.domains,
    gitSha,
    heavyShare: size.heavyShare,
    loadavg: { after: loadavg(), before: loadBefore },
    modes: Object.fromEntries(Object.entries(results).map(([mode, result]) => [mode, { ...result, active: summarize(result.samples) }])),
    preset: presetName,
    runs,
    shape,
};
const file = join(benchDirectory, "results", `startup-${presetName}-${report.at.replaceAll(/[:.]/gu, "-")}.json`);

writeFileSync(file, `${JSON.stringify(report, undefined, 4)}\n`, "utf8");

const rows = Object.entries(report.modes).map(([mode, result]) => [
    mode,
    String(result.functions),
    String(result.tables),
    `${result.active.median} / ${result.active.min} / ${result.active.max}`,
    `${result.eager.modules} / ${result.eager.total}`,
    mib(result.eager.bytes),
    `${result.registry.registryOnly.modules} (${result.registry.registryOnly.appModules} app of ${result.registry.all.appModules})`,
    `${mib(result.bundle.bytes)} (${mib(result.bundle.gzipBytes)} gz)`,
]);
const header = ["mode", "functions", "tables", "Active ms med/min/max", "eager modules / all", "eager bytes", "registry-only modules", "bundle"];
const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");

process.stdout.write(`\nstartup — ${presetName} (${runs} interleaved runs, load ${loadBefore[0].toFixed(1)} → ${loadavg()[0].toFixed(1)}, ${gitSha})\n`);
process.stdout.write(`${line(header)}\n${line(widths.map((width) => "-".repeat(width)))}\n${rows.map((row) => line(row)).join("\n")}\n`);
process.stdout.write(`\n${file}\n`);
