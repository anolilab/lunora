import { rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import { createRsbuild } from "@rsbuild/core";
import type { Compiler, Watching } from "@rspack/core";
import { rspack } from "@rspack/core";
import { afterAll, bench, describe } from "vitest";

import { SCHEMA } from "../__tests__/fixture";
import { lunoraRspack } from "../src/index";
import { lunoraRsbuild } from "../src/rsbuild";
import createBenchProject from "./fixture";

// End-to-end: a real Rspack (and Rsbuild) build of a minimal Lunora app with a
// 200-module `lunora/` (60 under CodSpeed), so the numbers include the bundler
// around the plugin.
//
//   - cold production build: a fresh compiler and plugin instance per iteration,
//     so the plugin's startup and first codegen pass are paid every time; the
//     no-plugin arm is the same build without it, so the delta is the plugin's share
//   - incremental watch rebuild: one long-lived `compiler.watch()`, timed from a
//     file write to the `done` of the compilation that saw it
//   - Rsbuild production build with two environments (web + node), the case where
//     one plugin instance is applied to two compilers
//
// Timings include the file watcher's latency, so compare arms within one run.

const reduced = process.env["CODSPEED_ENV"] !== undefined || process.env["CI"] === "true";
const root = createBenchProject(reduced ? 60 : 200);
const buildOptions = { iterations: reduced ? 2 : 8, time: 0, warmupIterations: 1 };

/** How long a watch rebuild may take before the bench fails instead of hanging. */
const REBUILD_TIMEOUT_MS = 60_000;
const appFile = join(root, "index.js");
const schemaFile = join(root, "lunora", "schema.ts");

/** Run with the plugin's per-pass advisories muted, so the bench output stays readable. */
const silence = <T>(run: () => Promise<T>): Promise<T> => {
    const { info, warn } = console;

    // eslint-disable-next-line no-console -- muting, not logging
    console.info = (): void => {};
    // eslint-disable-next-line no-console -- muting, not logging
    console.warn = (): void => {};

    return run().finally(() => {
        // eslint-disable-next-line no-console -- restoring what was muted
        console.info = info;
        // eslint-disable-next-line no-console -- restoring what was muted
        console.warn = warn;
    });
};

const runOnce = async (compiler: Compiler): Promise<void> =>
    new Promise((resolve, reject) => {
        compiler.run((error, stats) => {
            compiler.close(() => {
                if (error) {
                    reject(error);
                } else if (stats?.hasErrors()) {
                    reject(new Error(stats.toString({ all: false, errors: true })));
                } else {
                    resolve();
                }
            });
        });
    });

/** Promisified `close` of a `Watching` or `Compiler`; leaving either open keeps the worker alive. */
const closeWith = async (closable: { close: (callback: () => void) => void }): Promise<void> =>
    new Promise((resolve) => {
        closable.close(() => {
            resolve();
        });
    });

const createCompiler = (mode: "development" | "production", withPlugin = true): Compiler =>
    rspack({
        context: root,
        entry: "./index.js",
        mode,
        output: { path: join(root, "dist") },
        plugins: withPlugin ? [lunoraRspack({ projectRoot: root })] : [],
    });

/**
 * A watch session whose `next(path)` resolves when the compilation that saw
 * `path` (or its watched directory) modified finishes, and rejects after
 * {@link REBUILD_TIMEOUT_MS}. Builds that did not see it (a cascade off the
 * plugin's own writes) are counted in `extraBuilds` rather than awaited.
 */
const createWatchSession = (): { close: () => Promise<void>; extraBuilds: () => number; next: (path: string) => Promise<void>; ready: Promise<void> } => {
    const compiler = createCompiler("development");
    let pending: { path: string; reject: (error: Error) => void; resolve: () => void; timer: NodeJS.Timeout } | undefined;
    let extra = 0;
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
    });

    let first = true;

    const watching: Watching = compiler.watch({ aggregateTimeout: 5 }, (error, stats) => {
        // A failed build is not a rebuild to time: fail the measurement waiting on it.
        const failure = error ?? (stats?.hasErrors() ? new Error(stats.toString({ all: false, errors: true })) : undefined);

        if (failure !== undefined && pending !== undefined) {
            const { reject, timer } = pending;

            clearTimeout(timer);
            pending = undefined;
            reject(failure);

            return;
        }

        if (first) {
            first = false;
            resolveReady();

            return;
        }

        // A file under a watched directory is reported as that directory.
        const target = pending?.path;
        const saw = target !== undefined && [...(compiler.modifiedFiles ?? [])].some((changed) => target === changed || target.startsWith(`${changed}${sep}`));

        if (pending !== undefined && saw) {
            const { resolve, timer } = pending;

            clearTimeout(timer);
            pending = undefined;
            resolve();

            return;
        }

        extra += 1;
    });

    return {
        close: async () => {
            await closeWith(watching);
            await closeWith(compiler);
        },
        extraBuilds: () => extra,
        next: async (path) =>
            new Promise((resolve, reject) => {
                const fail = (): void => {
                    pending = undefined;
                    reject(new Error(`no rebuild saw ${path} within ${String(REBUILD_TIMEOUT_MS)}ms`));
                };

                pending = { path, reject, resolve, timer: setTimeout(fail, REBUILD_TIMEOUT_MS) };
            }),
        ready,
    };
};

let watch: ReturnType<typeof createWatchSession> | undefined;
let edits = 0;

/** A fresh value per edit, so every write really changes the file. */
const nextEdit = (): string => {
    edits += 1;

    return String(edits);
};

const rebuildAfter = async (path: string, content: string): Promise<void> => {
    watch ??= createWatchSession();
    await watch.ready;

    const done = watch.next(path);

    writeFileSync(path, content, "utf8");
    await done;
};

afterAll(async () => {
    if (watch !== undefined) {
        // eslint-disable-next-line no-console -- bench diagnostic: builds not caused by a bench edit
        console.info(`[rspack-build] watch builds no edit asked for: ${String(watch.extraBuilds())}`);
        await watch.close();
    }

    rmSync(root, { force: true, recursive: true });
});

describe("rspack build (real compiler)", () => {
    bench(
        "cold production build, no plugin (baseline)",
        async () => {
            await runOnce(createCompiler("production", false));
        },
        buildOptions,
    );

    bench(
        "cold production build",
        async () => {
            await silence(async () => runOnce(createCompiler("production")));
        },
        buildOptions,
    );

    bench(
        "rsbuild production build, two environments",
        async () => {
            await silence(async () => {
                const rsbuild = await createRsbuild({
                    cwd: root,
                    rsbuildConfig: {
                        environments: { node: { output: { distPath: { root: "dist-node" }, target: "node" } }, web: {} },
                        logLevel: "silent",
                        plugins: [lunoraRsbuild({ projectRoot: root, studio: false, worker: false })],
                        source: { entry: { index: "./index.js" } },
                    },
                });
                const { close } = await rsbuild.build();

                await close();
            });
        },
        buildOptions,
    );
});

describe("rspack watch rebuild (real compiler)", () => {
    const options = { iterations: reduced ? 3 : 20, time: 0, warmupIterations: reduced ? 1 : 2 };

    bench(
        "app file edited",
        async () => {
            await silence(async () => rebuildAfter(appFile, `console.log(${nextEdit()});\n`));
        },
        options,
    );

    // Under CodSpeed's instrumentation a schema edit's full codegen pass inside a
    // real watch rebuild runs past REBUILD_TIMEOUT_MS; `rebuild-hooks.bench.ts`
    // measures the plugin's share of the same edit there.
    bench.skipIf(reduced)(
        "lunora/schema.ts edited",
        async () => {
            await silence(async () => rebuildAfter(schemaFile, `${SCHEMA}\n// edit ${nextEdit()}\n`));
        },
        options,
    );
});
