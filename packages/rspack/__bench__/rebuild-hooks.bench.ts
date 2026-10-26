import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, bench, describe } from "vitest";

import { SCHEMA } from "../__tests__/fixture";
import type { CompilationLike, CompilerLike } from "../src/compiler";
import { resolveOptions } from "../src/options";
import { LunoraRspackPlugin } from "../src/plugin";
import createBenchProject from "./fixture";

// Per-rebuild cost of the plugin's own hooks, without Rspack's bundling around
// it: what `beforeCompile` + `afterCompile` add to every watch rebuild.
//
// The compiler is a minimal stand-in that records the taps and replays them the
// way a watch rebuild does, with `modifiedFiles` set as Rspack sets it: unset on
// the first compilation, the file itself for a file dependency, and the watched
// DIRECTORY for anything under `lunora/` (a context dependency). Three rebuild kinds:
//
//   - an app file edit, which touches nothing codegen reads (the common HMR case)
//   - a `lunora/` function file edit, which must re-run codegen
//   - a `schema.ts` edit, which must re-run codegen
//
// A 200-module `lunora/` (60 under CodSpeed, whose instrumented run is 50-100x
// slower) keeps the work that scales with it visible: fingerprinting every
// source, refreshing the ts-morph program.

type Tap<T> = (value: T) => Promise<void>;

interface BenchCompiler extends CompilerLike {
    modifiedFiles?: ReadonlySet<string>;
    removedFiles?: ReadonlySet<string>;
}

const noopSet = { add: (): void => {} };

const createHarness = (root: string): { rebuild: (changed: string | undefined) => Promise<void> } => {
    let beforeCompile: Tap<unknown> | undefined;
    let afterCompile: Tap<CompilationLike> | undefined;

    const compiler: BenchCompiler = {
        hooks: {
            afterCompile: {
                tapPromise: (_name, callback) => {
                    afterCompile = callback;
                },
            },
            beforeCompile: {
                tapPromise: (_name, callback) => {
                    beforeCompile = callback;
                },
            },
        },
        watchMode: true,
    };

    new LunoraRspackPlugin(resolveOptions({ projectRoot: root })).apply(compiler);

    return {
        rebuild: async (changed: string | undefined): Promise<void> => {
            compiler.modifiedFiles = changed === undefined ? undefined : new Set([changed]);
            compiler.removedFiles = changed === undefined ? undefined : new Set();
            await beforeCompile?.({});
            await afterCompile?.({ contextDependencies: noopSet, errors: [], fileDependencies: noopSet, missingDependencies: noopSet });
        },
    };
};

const reduced = process.env["CODSPEED_ENV"] !== undefined || process.env["CI"] === "true";
const root = createBenchProject(reduced ? 60 : 200);
const harness = createHarness(root);
const appFile = join(root, "index.js");
const schemaDirectory = join(root, "lunora");
const functionFile = join(schemaDirectory, "mod0.ts");
const schemaFile = join(schemaDirectory, "schema.ts");

// The first watch compilation: startup work and the initial codegen pass.
await harness.rebuild(undefined);

let edits = 0;

/** A fresh value per edit, so every write really changes the file. */
const nextEdit = (): string => {
    edits += 1;

    return String(edits);
};

afterAll(() => {
    rmSync(root, { force: true, recursive: true });
});

describe("watch rebuild: plugin hook cost", () => {
    const options = { iterations: reduced ? 5 : 30, time: 0, warmupIterations: reduced ? 1 : 3 };

    bench(
        "app file edited (nothing under lunora/ changed)",
        async () => {
            writeFileSync(appFile, `console.log(${nextEdit()});\n`, "utf8");
            await harness.rebuild(appFile);
        },
        options,
    );

    bench(
        "lunora/ function file edited",
        async () => {
            writeFileSync(
                functionFile,
                `import { query } from "./_generated/server";\n\nexport const list0 = query({ args: {}, handler: async () => [${nextEdit()}] });\n`,
                "utf8",
            );
            await harness.rebuild(schemaDirectory);
        },
        options,
    );

    bench(
        "lunora/schema.ts edited",
        async () => {
            writeFileSync(schemaFile, `${SCHEMA}\n// edit ${nextEdit()}\n`, "utf8");
            await harness.rebuild(schemaDirectory);
        },
        options,
    );
});
