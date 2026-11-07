/**
 * What every bench script does around its measurement: generate the app at a size,
 * build it in each registry mode, and put the tree back to the committed core-only
 * state afterwards.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildWorker, quietEnv as measureEnv } from "./worker-startup-measure.js";
import { appDirectory, generate } from "./generate.mjs";

export const benchDirectory = join(appDirectory, ".bench");
export const cli = join(appDirectory, "node_modules", "lunorash", "dist", "bin.mjs");
export const wrangler = join(appDirectory, "node_modules", ".bin", "wrangler");
export const quietEnv = measureEnv();

/** `list` rotated by `run`, so no candidate always runs first and position effects average out. */
export const rotated = (list, run) => list.map((_, index) => list[(index + run) % list.length]);

export const parseModes = (list) => {
    const modes = list.split(",").map((mode) => mode.trim());

    if (modes.some((mode) => mode !== "eager" && mode !== "lazy")) {
        throw new Error(`--modes takes eager and/or lazy, got "${list}"`);
    }

    // A repeated mode is measured twice per run and reported under one label, so the run count would overstate the samples.
    if (new Set(modes).size !== modes.length) {
        throw new Error(`--modes lists a mode more than once: "${list}"`);
    }

    return modes;
};

/** A `--runs`-style count. `Number()` alone turns "nope" into NaN (a loop that never runs) and accepts Infinity (a loop that never ends). */
export const countArg = (name, value, min = 1) => {
    const count = Number(value);

    if (!Number.isInteger(count) || count < min) {
        throw new Error(`--${name} takes a whole number of at least ${String(min)}, got "${value}"`);
    }

    return count;
};

/** The name results are filed under: the preset, or the domain count and heavy share. */
export const sizeLabel = ({ domains, preset }, size) =>
    preset ?? (domains === undefined ? "core" : `domains-${String(size.domains)}${size.heavyShare > 0 ? `-heavy-${String(size.heavyShare)}` : ""}`);

/**
 * `lunora build` in `mode` into `.bench/out-<mode>`: codegen in that registry mode and
 * wrangler's single-file esbuild bundle (`server.js`) plus its metafile.
 */
export const buildMode = (mode) =>
    buildWorker(appDirectory, {
        cli,
        extraArgs: ["--no-framework-build", "--api-spec", "both", ...(mode === "lazy" ? ["--lazy-functions"] : [])],
        outDir: `.bench/out-${mode}`,
    });

/** Generates `size`, runs `measure`, and unless `keep` restores the committed core-only tree, `_generated/` included. */
export const withSizedApp = async (size, { keep }, measure) => {
    // `lunora build` advances the schema baseline; the committed one describes the core-only app.
    const schemaBaseline = join(appDirectory, "lunora", ".lunora-schema.json");
    const committedBaseline = readFileSync(schemaBaseline, "utf8");
    try {
        return await measure(generate(size));
    } finally {
        if (!keep) {
            generate({ domains: 0 });
            writeFileSync(schemaBaseline, committedBaseline, "utf8");
            // Leave `_generated/` eager and core-only, matching the tree, so `tsc` and `lunora dev` see what is committed.
            execFileSync(process.execPath, [cli, "codegen", "--api-spec", "both"], {
                cwd: appDirectory,
                env: quietEnv,
                stdio: ["ignore", "ignore", "inherit"],
            });
        }
    }
};
