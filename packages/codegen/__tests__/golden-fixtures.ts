import { cpSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CodegenResult } from "../src/index";

/** `packages/codegen/__tests__/fixtures` — where both the fixtures and their scratch workdirs live. */
const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * Copy a fixture's `lunora/` app into a fresh scratch workdir, leaving the
 * committed `_generated/` behind. Discovery already skips `_generated/`, but
 * keeping it out of the workdir makes that independence structural rather than
 * assumed: a golden can never quietly become an input to the run that reproduces
 * it.
 *
 * The workdir is created **beside the fixtures**, not in `os.tmpdir()`.
 * `createCodegenProject` walks up from the app for a `tsconfig.json` and falls
 * back to an isolated ts-morph project when it finds none, and module resolution
 * needs a `node_modules` up the same chain. An `os.tmpdir()` workdir has neither,
 * so every cross-module type the emitter asks for came back `any` and the goldens
 * recorded `unknown` where a real project infers `Id<"notes">` / `Doc_notes[]` —
 * byte-equality then locked the degraded inference in, and a regression that
 * erased a return type showed up as no diff at all. Under `fixtures/` the walk-up
 * finds `packages/codegen/tsconfig.json` and the workspace `node_modules`, which
 * is what a scaffolded app has.
 *
 * `.workdir-*` is gitignored so a run killed before its cleanup cannot fail the
 * repo-clean check in `scripts/check-generated-files.mjs`.
 */
const makeFixtureWorkdir = (fixtureRoot: string): string => {
    const workdir = mkdtempSync(join(fixturesDirectory, ".workdir-"));

    cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), {
        filter: (source) => !source.includes("_generated"),
        recursive: true,
    });

    return workdir;
};

/**
 * The fixture apps whose full `_generated/` output is committed and asserted
 * byte-for-byte, as `[fixture directory, golden directory relative to it]`.
 *
 * `simple` is the broad one (most tables, most add-ons); its golden sits under
 * `expected/` because nothing compiles it.
 *
 * `delta-sync` keeps its golden where a real project keeps it — `lunora/_generated`
 * — because it IS compiled: emitted code says `import schema from "../schema.js"`,
 * which only resolves from inside the app tree it was written for. Discovery
 * skips `_generated/`, so the committed output never feeds back into the run
 * that regenerates it.
 *
 * It exists because feature coverage here is per-emission-gate, not per-line:
 * the local-first sync overrides (`resolveShape`, `readGlobalShapeRows`,
 * `readGlobalChangedTables`) are emitted only when a project declares BOTH
 * `defineShape`s and `.global()` tables, and no fixture, example or template
 * did — so the whole delta-sync subsystem shipped with zero generated output
 * behind it. That is how the global writers came to be built without the shard's
 * `cdc` flag: the substring tests construct the writers directly with CDC on, so
 * the one thing nobody asserted was what codegen actually wires.
 *
 * Shared by `capture-expected.ts` (which writes the goldens) and the tests that
 * assert them, so a new fixture is registered once.
 */
const GOLDEN_FIXTURES: ReadonlyArray<readonly [string, string]> = [
    ["simple", "expected/_generated"],
    ["delta-sync", "lunora/_generated"],
];

/** Every emitted artifact captured into a golden directory, as `[filename, CodegenResult key]`. */
const GOLDEN_OUTPUTS: ReadonlyArray<readonly [string, keyof CodegenResult["generated"]]> = [
    ["app.ts", "app"],
    ["api.ts", "api"],
    ["server.ts", "server"],
    ["dataModel.ts", "dataModel"],
    ["drizzle.global.ts", "drizzleGlobal"],
    ["drizzle.shard.ts", "drizzleShard"],
    ["shard.ts", "shard"],
    ["functions.ts", "functions"],
    ["openapi.json", "openApi"],
    ["openapi.ts", "openApiModule"],
    ["openrpc.json", "openRpc"],
    ["openrpc.ts", "openRpcModule"],
];

export { GOLDEN_FIXTURES, GOLDEN_OUTPUTS, makeFixtureWorkdir };
