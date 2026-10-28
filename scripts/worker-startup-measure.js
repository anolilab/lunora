/**
 * Worker startup measurement shared by `check-worker-startup.js` (the CI gate on a
 * synthetic app) and `apps/bench` (the realistic app). Every function throws
 * instead of exiting, so each caller decides what a failure means to it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const quietEnv = () => {
    return { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
};

/**
 * `lunora build` into `outDir` (relative to `appDirectory`). `--no-strict-advisories`
 * because the advisory gate is about the app's security, not its startup, and CI
 * turns it on by default.
 */
export const buildWorker = (appDirectory, { cli, extraArgs = [], outDir = "out" }) => {
    if (!existsSync(cli)) {
        throw new Error(`${cli} is missing — build the CLI first (\`pnpm --filter "lunorash..." run build:prod\`).`);
    }

    try {
        execFileSync(process.execPath, [cli, "build", "--no-strict-advisories", "--format", "json", "--out-dir", outDir, ...extraArgs], {
            cwd: appDirectory,
            encoding: "utf8",
            env: quietEnv(),
            maxBuffer: 64 * 1024 * 1024,
            stdio: ["ignore", "pipe", "inherit"],
        });
    } catch (error) {
        throw new Error(`\`lunora build\` failed in ${appDirectory} (its output is above)`, { cause: error });
    }

    return join(appDirectory, outDir);
};

const readMetafile = (outDirectory) => {
    const metafilePath = join(outDirectory, "bundle-meta.json");

    if (!existsSync(metafilePath)) {
        throw new Error(`\`lunora build\` wrote no bundle-meta.json to ${outDirectory} — the out-dir layout may have changed.`);
    }

    return JSON.parse(readFileSync(metafilePath, "utf8")).inputs;
};

/** Static-edge reachability from the metafile's roots, refusing to enter any path `skip` accepts. */
const reach = (inputs, skip) => {
    const imported = new Set();

    for (const input of Object.values(inputs)) {
        for (const edge of input.imports) {
            imported.add(edge.path);
        }
    }

    // The wrangler metafile tags no entry point, so the roots are the inputs nothing imports.
    const roots = Object.keys(inputs).filter((path) => !imported.has(path));
    const seen = new Set();
    const stack = [...roots];

    while (stack.length > 0) {
        const path = stack.pop();

        if (seen.has(path) || !inputs[path] || skip(path)) {
            continue;
        }

        seen.add(path);

        for (const edge of inputs[path].imports) {
            if (edge.kind !== "dynamic-import") {
                stack.push(edge.path);
            }
        }
    }

    return { roots, seen };
};

const sumBytes = (inputs, paths) => {
    let bytes = 0;

    for (const path of paths) {
        bytes += inputs[path].bytes;
    }

    return bytes;
};

/**
 * Modules and bytes reachable from the entry through static edges. A dynamic-only
 * module is not reachable, which is the point: deferring a module lowers the count.
 */
export const eagerGraph = (outDirectory) => {
    const inputs = readMetafile(outDirectory);
    const { roots, seen } = reach(inputs, () => false);

    if (roots.length === 0 || seen.size < 50) {
        throw new Error(`measured ${seen.size} modules from ${roots.length} roots — the metafile layout may have changed.`);
    }

    return { bytes: sumBytes(inputs, seen), modules: seen.size, total: Object.keys(inputs).length };
};

/**
 * The eager graph split by whether a module stays reachable once the generated
 * function registry is cut off: `registryOnly` is what a lazy registry can defer at
 * most. `appPrefix` (e.g. `"lunora/"`) counts the app's own modules in each part.
 */
export const registrySplit = (outDirectory, { appPrefix, registry = "_generated/functions.ts" }) => {
    const inputs = readMetafile(outDirectory);
    const all = reach(inputs, () => false).seen;
    const withoutRegistry = reach(inputs, (path) => path.endsWith(registry)).seen;
    const registryOnly = [...all].filter((path) => !withoutRegistry.has(path));
    const isApp = (path) => path.includes(appPrefix) && !path.includes("node_modules") && !path.includes("_generated/");

    return {
        all: { appModules: [...all].filter(isApp).length, bytes: sumBytes(inputs, all), modules: all.size },
        registryOnly: { appModules: registryOnly.filter(isApp).length, bytes: sumBytes(inputs, registryOnly), modules: registryOnly.length },
    };
};

/**
 * One `wrangler check startup` run; returns Active ms. `workerBundle` is a
 * `wrangler deploy --outfile` bundle; without it wrangler re-bundles `main` from
 * source, so whatever `_generated/` is on disk decides what is measured.
 */
export const startupActiveMs = (appDirectory, { profile, timeout = 120_000, wrangler, workerBundle }) => {
    const args = ["check", "startup", "--outfile", profile, ...(workerBundle ? ["--workerBundle", workerBundle] : [])];
    const output = execFileSync(wrangler, args, { cwd: appDirectory, encoding: "utf8", env: quietEnv(), stdio: ["ignore", "pipe", "pipe"], timeout });
    const match = /Active:\s+([\d.]+) ms/.exec(output);

    if (!match) {
        throw new Error(`\`wrangler check startup\` printed no Active time:\n${output}`);
    }

    return Number(match[1]);
};

/** min / median / max of a sample list. */
export const summarize = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);

    return { max: sorted.at(-1), median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], runs: sorted.length };
};
