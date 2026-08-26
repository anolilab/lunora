import { cpSync } from "node:fs";
import { join } from "node:path";

import type { CodegenResult } from "../src/index";

/**
 * Copy a fixture's `lunora/` app into a scratch workdir, leaving the committed
 * `_generated/` behind. Discovery already skips `_generated/`, but keeping it out
 * of the workdir makes that independence structural rather than assumed: a golden
 * can never quietly become an input to the run that reproduces it.
 */
const copyFixtureApp = (fixtureRoot: string, workdir: string): void => {
    cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), {
        filter: (source) => !source.includes("_generated"),
        recursive: true,
    });
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

export { copyFixtureApp, GOLDEN_FIXTURES, GOLDEN_OUTPUTS };
