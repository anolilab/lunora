/**
 * What every bench script does around its measurement: generate the app at a size,
 * build it in each registry mode, and put the tree back to the committed core-only
 * state afterwards.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildWorker } from "../../../scripts/worker-startup-measure.js";
import { appDirectory, generate } from "./generate.mjs";

export const benchDirectory = join(appDirectory, ".bench");
export const cli = join(appDirectory, "node_modules", "lunorash", "dist", "bin.mjs");
export const wrangler = join(appDirectory, "node_modules", ".bin", "wrangler");
export const quietEnv = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };

export const parseModes = (list) => {
    const modes = list.split(",").map((mode) => mode.trim());

    if (modes.some((mode) => mode !== "eager" && mode !== "lazy")) {
        throw new Error(`--modes takes eager and/or lazy, got "${list}"`);
    }

    return modes;
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
    const shape = generate(size);

    try {
        return await measure(shape);
    } finally {
        if (!keep) {
            generate({ domains: 0 });
            writeFileSync(schemaBaseline, committedBaseline, "utf8");
            // Leave `_generated/` eager and core-only, matching the tree, so `tsc` and `lunora dev` see what is committed.
            execFileSync(process.execPath, [cli, "codegen", "--api-spec", "both"], { cwd: appDirectory, env: quietEnv, stdio: "ignore" });
        }
    }
};
